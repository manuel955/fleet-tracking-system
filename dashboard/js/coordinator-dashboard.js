// Panel de despacho para coordinadores. Usa RTDB en tiempo real sobre el
// espejo privado coordinatorTrips/{uid}; nunca lee el mapa ni la flota.

(() => {
  const coordinatorApp = document.getElementById('coordinator-app');
  const placeNameEl = document.getElementById('coordinator-place-name');
  const userNameEl = document.getElementById('coordinator-user-name');
  const originInput = document.getElementById('coordinator-origin-input');
  const destinationInput = document.getElementById('coordinator-destination-input');
  const suggestionsEl = document.getElementById('coordinator-destination-suggestions');
  const passengerNameInput = document.getElementById('coordinator-passenger-name');
  const passengerPhoneInput = document.getElementById('coordinator-passenger-phone');
  const passengerCountInput = document.getElementById('coordinator-passenger-count');
  const previewMapEl = document.getElementById('coordinator-map-preview');
  const previewStatusEl = document.getElementById('coordinator-map-preview-status');
  const previewMessageEl = document.getElementById('coordinator-map-preview-message');
  const requestForm = document.getElementById('coordinator-request-form');
  const requestSubmit = document.getElementById('coordinator-request-submit');
  const feedbackEl = document.getElementById('coordinator-request-feedback');
  const tripsListEl = document.getElementById('coordinator-trips-list');
  const tripCountEl = document.getElementById('coordinator-trip-count');
  const modalEl = document.getElementById('coordinator-trip-modal');
  const modalTitleEl = document.getElementById('coordinator-modal-title');
  const modalContentEl = document.getElementById('coordinator-modal-content');
  const modalActionsEl = document.getElementById('coordinator-modal-actions');
  const modalCloseEl = document.getElementById('coordinator-modal-close');
  const logoutEl = document.getElementById('coordinator-logout-btn');

  const functionsBase = 'https://us-central1-rastreoflota-53052.cloudfunctions.net';
  const statusLabels = {
    searching: 'Buscando conductor',
    scheduled: 'Buscando conductor',
    no_drivers_available: 'Sin conductores disponibles',
    assigned_pending_accept: 'Conductor asignado',
    accepted: 'Conductor asignado',
    arrived_at_pickup: 'En ruta',
    in_progress: 'En ruta',
    completed: 'Completado',
    cancelled: 'Cancelado',
  };
  const statusClasses = {
    searching: 'searching',
    scheduled: 'searching',
    no_drivers_available: 'searching',
    assigned_pending_accept: 'assigned',
    accepted: 'assigned',
    arrived_at_pickup: 'on-route',
    in_progress: 'on-route',
    completed: 'completed',
    cancelled: 'cancelled',
  };

  let coordinatorUser = null;
  let coordinatorClaims = {};
  let coordinatorPlace = null;
  let trips = {};
  let tripListenerRef = null;
  let selectedDestination = null;
  let suggestionTimer = null;
  let suggestions = [];
  let selectedTripId = null;
  let modalRequestToken = 0;
  let previewMap = null;
  let previewMapReady = false;
  let previewOriginMarker = null;
  let previewDestinationMarker = null;
  let started = false;

  const esc = (value) => (typeof escapeHtml === 'function'
    ? escapeHtml(String(value ?? ''))
    : String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])));

  function limaDayKey(value) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(Number(value) || 0));
  }

  function isToday(trip) {
    return limaDayKey(trip.requestedAt) === limaDayKey(Date.now());
  }

  function formatTime(value) {
    if (!value) return '—';
    return new Date(Number(value)).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
  }

  function statusLabel(status) {
    return statusLabels[status] || 'Actualizando';
  }

  function showFeedback(message, kind = '') {
    feedbackEl.textContent = message || '';
    feedbackEl.className = `settings-feedback${kind ? ` ${kind}` : ''}`;
  }

  async function coordinatorRequest(path, payload) {
    const token = await auth.currentUser.getIdToken();
    const options = {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    if (payload) options.body = JSON.stringify(payload);
    const response = await fetch(`${functionsBase}/${path}`, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'No se pudo completar la operación.');
    return result;
  }

  function mapboxToken() {
    return window.DASHBOARD_MAP_CONFIG?.accessToken || window.__MAPBOX_ACCESS_TOKEN__ || '';
  }

  async function searchDestinations(query) {
    const token = mapboxToken();
    if (!token || query.trim().length < 3) return [];
    const proximity = coordinatorPlace
      ? `&proximity=${coordinatorPlace.lng},${coordinatorPlace.lat}`
      : '';
    const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(query.trim())}&autocomplete=true&limit=5&language=es&country=pe${proximity}&permanent=false&access_token=${encodeURIComponent(token)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('No se pudo buscar la dirección.');
    const data = await response.json();
    return (data.features || []).map((feature) => ({
      label: feature.properties?.full_address || feature.properties?.name || feature.place_name || query,
      lat: Number(feature.geometry?.coordinates?.[1]),
      lng: Number(feature.geometry?.coordinates?.[0]),
    })).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
  }

  function renderSuggestions() {
    if (!suggestions.length) {
      suggestionsEl.innerHTML = '<div class="coordinator-suggestion-empty">Sin coincidencias</div>';
      suggestionsEl.classList.remove('hidden');
      return;
    }
    suggestionsEl.innerHTML = suggestions.map((suggestion, index) => `
      <button type="button" class="coordinator-suggestion" data-suggestion-index="${index}">
        <span>⌖</span><span>${esc(suggestion.label)}</span>
      </button>
    `).join('');
    suggestionsEl.classList.remove('hidden');
    suggestionsEl.querySelectorAll('[data-suggestion-index]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedDestination = suggestions[Number(button.dataset.suggestionIndex)];
        destinationInput.value = selectedDestination.label;
        suggestionsEl.classList.add('hidden');
        updateDestinationPreview();
      });
    });
  }

  function isValidPoint(point) {
    return point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng));
  }

  function previewIcon(color, glyph) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44"><path d="M18 1C8.6 1 2 7.8 2 16.4c0 10.4 16 25.6 16 25.6s16-15.2 16-25.6C34 7.8 27.4 1 18 1Z" fill="${color}" stroke="#fff" stroke-width="3"/><circle cx="18" cy="16" r="7" fill="#fff"/><text x="18" y="20" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="${color}">${glyph}</text></svg>`;
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      width: 36,
      height: 44,
    };
  }

  function setPreviewMessage(message, kind = '') {
    if (!previewMessageEl) return;
    previewMessageEl.textContent = message || '';
    previewMessageEl.className = `coordinator-map-preview-message${kind ? ` ${kind}` : ''}`;
  }

  function updateDestinationPreview() {
    if (!previewMap || !previewMapReady) return;
    const origin = isValidPoint(coordinatorPlace) ? coordinatorPlace : null;
    const destination = isValidPoint(selectedDestination) ? selectedDestination : null;

    if (origin && !previewOriginMarker) {
      previewOriginMarker = previewMap.createMarker({
        position: origin,
        icon: previewIcon('#06a95b', 'S'),
        title: 'Origen: sede asignada',
        map: previewMap,
      });
    } else if (origin && previewOriginMarker) {
      previewOriginMarker.setPosition(origin, { durationMs: 0 });
    }

    if (!destination) {
      if (previewDestinationMarker) {
        previewDestinationMarker.setMap(null);
        previewDestinationMarker = null;
      }
      if (origin) previewMap.setView(origin, 13);
      if (previewStatusEl) previewStatusEl.textContent = 'Selecciona una dirección del buscador.';
      setPreviewMessage(origin
        ? 'Origen de la sede listo. Selecciona un destino para confirmarlo.'
        : 'La sede no tiene coordenadas configuradas. Selecciona un destino para verlo.');
      return;
    }

    if (!previewDestinationMarker) {
      previewDestinationMarker = previewMap.createMarker({
        position: destination,
        icon: previewIcon('#7c3aed', 'D'),
        title: 'Destino seleccionado',
        map: previewMap,
      });
    } else {
      previewDestinationMarker.setPosition(destination, { durationMs: 0 });
    }

    if (previewStatusEl) previewStatusEl.textContent = 'Destino seleccionado. Verifica el punto antes de solicitar.';
    setPreviewMessage(`Destino: ${destination.label || 'ubicación seleccionada'}`);
    if (origin && Math.abs(origin.lat - destination.lat) > 0.0001 && Math.abs(origin.lng - destination.lng) > 0.0001 && window.mapboxgl) {
      const bounds = new window.mapboxgl.LngLatBounds();
      bounds.extend([Number(origin.lng), Number(origin.lat)]);
      bounds.extend([Number(destination.lng), Number(destination.lat)]);
      previewMap.fitBounds(bounds, { padding: 52, maxZoom: 15 });
    } else {
      previewMap.setView(destination, 15);
    }
  }

  function destroyPreviewMap() {
    if (previewOriginMarker) previewOriginMarker.setMap(null);
    if (previewDestinationMarker) previewDestinationMarker.setMap(null);
    previewOriginMarker = null;
    previewDestinationMarker = null;
    if (previewMap?.remove) previewMap.remove();
    previewMap = null;
    previewMapReady = false;
  }

  function initPreviewMap() {
    if (!previewMapEl || !window.MapboxMapAdapter) return;
    destroyPreviewMap();
    const center = isValidPoint(coordinatorPlace)
      ? coordinatorPlace
      : { lat: -12.0464, lng: -77.0428 };
    try {
      previewMap = new window.MapboxMapAdapter({ container: previewMapEl, center, zoom: 13 });
      previewMap.ready.then(() => {
        previewMapReady = true;
        previewMap.resize();
        updateDestinationPreview();
      }).catch(() => {
        if (previewStatusEl) previewStatusEl.textContent = 'Mapa no disponible';
        setPreviewMessage('No se pudo cargar el mapa. Puedes continuar seleccionando el destino.', 'error');
      });
    } catch (_) {
      if (previewStatusEl) previewStatusEl.textContent = 'Mapa no disponible';
      setPreviewMessage('No se pudo inicializar el mapa. Puedes continuar seleccionando el destino.', 'error');
    }
  }

  function renderTrips() {
    const today = Object.entries(trips)
      .filter(([, trip]) => trip && isToday(trip))
      .sort(([, a], [, b]) => Number(b.requestedAt || 0) - Number(a.requestedAt || 0));
    tripCountEl.textContent = String(today.length);
    if (!today.length) {
      tripsListEl.innerHTML = '<p class="coordinator-empty-state">Aún no hay solicitudes para hoy.</p>';
      return;
    }
    tripsListEl.innerHTML = today.map(([tripId, trip]) => `
      <button type="button" class="coordinator-trip-row" data-coordinator-trip-id="${esc(tripId)}">
        <span class="coordinator-trip-row-top"><b>${esc(trip.destinationAddress || 'Destino sin dirección')}</b><time>${esc(formatTime(trip.requestedAt))}</time></span>
        <span class="coordinator-trip-row-bottom">
          <span class="coordinator-status-pill ${statusClasses[trip.status] || ''}"><i></i>${esc(statusLabel(trip.status))}</span>
          <span>${esc(trip.driverName ? `${trip.driverName} · ${trip.driverPlate || 'sin placa'}` : 'Esperando asignación')}</span>
        </span>
      </button>
    `).join('');
    tripsListEl.querySelectorAll('[data-coordinator-trip-id]').forEach((button) => {
      button.addEventListener('click', () => openTripModal(button.dataset.coordinatorTripId));
    });
  }

  function driverField(trip, detail, label, value) {
    return `<div class="coordinator-detail-row"><span>${esc(label)}</span><b>${value || '—'}</b></div>`;
  }

  function canCancel(trip) {
    return !['in_progress', 'completed', 'cancelled'].includes(trip.status);
  }

  function renderModal(trip, detail, etaLabel = 'Consultando…') {
    const phone = String(trip.driverPhone || '').replace(/[^+\d]/g, '');
    const phoneLink = phone ? `<a href="tel:${esc(phone)}">${esc(trip.driverPhone)}</a>` : '—';
    const etaTarget = trip.status === 'in_progress' ? 'hasta el destino' : 'hasta la sede';
    modalTitleEl.textContent = `Viaje ${String(selectedTripId || '').slice(-8)}`;
    modalContentEl.innerHTML = `
      <div class="coordinator-modal-status"><span class="coordinator-status-pill ${statusClasses[trip.status] || ''}"><i></i>${esc(statusLabel(trip.status))}</span><span>${esc(formatTime(trip.requestedAt))}</span></div>
      <div class="coordinator-detail-block"><h3>Servicio</h3>
        ${driverField(trip, detail, 'ID de viaje', esc(selectedTripId || '—'))}
        ${driverField(trip, detail, 'Origen', esc(trip.pickupAddress || '—'))}
        ${driverField(trip, detail, 'Destino', esc(trip.destinationAddress || '—'))}
        ${driverField(trip, detail, 'Pasajero', esc(trip.passengerName || '—'))}
        ${driverField(trip, detail, 'Teléfono del pasajero', trip.passengerPhone ? `<a href="tel:${esc(trip.passengerPhone)}">${esc(trip.passengerPhone)}</a>` : '—')}
        ${driverField(trip, detail, 'Pasajeros', esc(String(Number(trip.passengerCount) || 1)))}
      </div>
      <div class="coordinator-detail-block"><h3>Conductor y vehículo</h3>
        ${driverField(trip, detail, 'Conductor', esc(trip.driverName || 'Aún no asignado'))}
        ${driverField(trip, detail, 'Teléfono', phoneLink)}
        ${driverField(trip, detail, 'Placa', esc(trip.driverPlate || '—'))}
        ${driverField(trip, detail, 'Modelo', esc([trip.vehicleBrand, trip.vehicleType].filter(Boolean).join(' · ') || '—'))}
        ${driverField(trip, detail, 'ETA', `${esc(etaLabel)}${trip.driverId && etaLabel !== '—' ? ` <small>${esc(etaTarget)}</small>` : ''}`)}
      </div>
    `;
    modalActionsEl.innerHTML = canCancel(trip)
      ? '<button type="button" id="coordinator-cancel-trip" class="coordinator-danger-btn">Cancelar viaje</button>'
      : '';
    const cancelButton = document.getElementById('coordinator-cancel-trip');
    if (cancelButton) cancelButton.addEventListener('click', () => cancelTrip(selectedTripId));
  }

  async function fetchEta(trip, detail) {
    if (!trip.driverId || !detail?.driverLocation) return '—';
    const target = trip.status === 'in_progress'
      ? { lat: Number(trip.destinationLat), lng: Number(trip.destinationLng) }
      : { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) };
    if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) return '—';
    const token = mapboxToken();
    if (!token) return 'No disponible';
    const origin = detail.driverLocation;
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${origin.lng},${origin.lat};${target.lng},${target.lat}?overview=false&access_token=${encodeURIComponent(token)}`;
    const response = await fetch(url);
    if (!response.ok) return 'No disponible';
    const route = (await response.json()).routes?.[0];
    if (!route || !Number.isFinite(Number(route.duration))) return 'No disponible';
    const minutes = Math.round(Number(route.duration) / 60);
    return minutes < 1 ? 'Menos de 1 min' : `${minutes} min`;
  }

  async function openTripModal(tripId) {
    const trip = trips[tripId];
    if (!trip) return;
    selectedTripId = tripId;
    modalEl.classList.remove('hidden');
    modalEl.setAttribute('aria-hidden', 'false');
    renderModal(trip, null);
    const requestToken = ++modalRequestToken;
    try {
      const detail = await coordinatorRequest(`getCoordinatorTripDetail?tripId=${encodeURIComponent(tripId)}`);
      const eta = await fetchEta(trip, detail);
      if (requestToken !== modalRequestToken || selectedTripId !== tripId) return;
      renderModal(trips[tripId] || trip, detail, eta);
    } catch (_) {
      if (requestToken === modalRequestToken) renderModal(trips[tripId] || trip, null, 'No disponible');
    }
  }

  function closeModal() {
    selectedTripId = null;
    modalRequestToken += 1;
    modalEl.classList.add('hidden');
    modalEl.setAttribute('aria-hidden', 'true');
  }

  async function cancelTrip(tripId) {
    const trip = trips[tripId];
    if (!trip || !canCancel(trip)) return;
    if (!confirm('¿Cancelar este viaje?')) return;
    const button = document.getElementById('coordinator-cancel-trip');
    if (button) button.disabled = true;
    try {
      await coordinatorRequest('cancelCoordinatorTrip', { tripId });
      closeModal();
    } catch (error) {
      if (button) button.disabled = false;
      alert(error.message || 'No se pudo cancelar el viaje.');
    }
  }

  async function requestTrip(event) {
    event.preventDefault();
    if (!selectedDestination) {
      showFeedback('Selecciona un destino de la lista.', 'error');
      destinationInput.focus();
      return;
    }
    const passengerCount = Number.parseInt(passengerCountInput.value, 10);
    if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 45) {
      showFeedback('Indica entre 1 y 45 pasajeros.', 'error');
      passengerCountInput.focus();
      return;
    }
    requestSubmit.disabled = true;
    showFeedback('Solicitando vehículo…');
    try {
      const result = await coordinatorRequest('createCoordinatorTrip', {
        destinationAddress: selectedDestination.label,
        destinationLat: selectedDestination.lat,
        destinationLng: selectedDestination.lng,
        passengerName: passengerNameInput.value.trim(),
        passengerPhone: passengerPhoneInput.value.trim(),
        passengerCount,
      });
      trips[result.tripId] = result.trip;
      renderTrips();
      destinationInput.value = '';
      passengerNameInput.value = '';
      passengerPhoneInput.value = '';
      passengerCountInput.value = '1';
      selectedDestination = null;
      suggestions = [];
      suggestionsEl.classList.add('hidden');
      updateDestinationPreview();
      showFeedback('Solicitud creada.', 'success');
    } catch (error) {
      showFeedback(error.message || 'No se pudo solicitar el vehículo.', 'error');
    } finally {
      requestSubmit.disabled = false;
    }
  }

  function listenTrips() {
    if (tripListenerRef) tripListenerRef.off();
    tripListenerRef = db.ref(`coordinatorTrips/${coordinatorUser.uid}`);
    tripListenerRef.on('value', (snapshot) => {
      trips = snapshot.val() || {};
      renderTrips();
      if (selectedTripId && trips[selectedTripId]) openTripModal(selectedTripId);
    });
  }

  function stopCoordinatorDispatch() {
    if (tripListenerRef) tripListenerRef.off();
    tripListenerRef = null;
    destroyPreviewMap();
    coordinatorUser = null;
    coordinatorPlace = null;
    coordinatorClaims = {};
    trips = {};
    selectedDestination = null;
    suggestions = [];
    started = false;
    closeModal();
  }

  function startCoordinatorDispatch(user, claims = {}) {
    if (started && coordinatorUser?.uid === user.uid) return;
    stopCoordinatorDispatch();
    started = true;
    coordinatorUser = user;
    coordinatorClaims = claims;
    coordinatorPlace = {
      id: String(claims.sedeId || ''),
      type: String(claims.sedeType || ''),
      name: String(claims.sedeName || 'Sede asignada'),
      address: String(claims.sedeAddress || ''),
      lat: Number(claims.sedeLat),
      lng: Number(claims.sedeLng),
    };
    placeNameEl.textContent = coordinatorPlace.name;
    userNameEl.textContent = user.displayName || user.email || 'Coordinador';
    originInput.value = coordinatorPlace.address
      ? `${coordinatorPlace.name} · ${coordinatorPlace.address}`
      : coordinatorPlace.name;
    originInput.title = coordinatorPlace.address || coordinatorPlace.name;
    coordinatorApp.classList.remove('hidden');
    initPreviewMap();
    listenTrips();
  }

  destinationInput.addEventListener('input', () => {
    selectedDestination = null;
    updateDestinationPreview();
    clearTimeout(suggestionTimer);
    const query = destinationInput.value;
    if (query.trim().length < 3) {
      suggestions = [];
      suggestionsEl.classList.add('hidden');
      return;
    }
    suggestionTimer = setTimeout(async () => {
      try {
        suggestions = await searchDestinations(query);
        renderSuggestions();
      } catch (error) {
        suggestions = [];
        suggestionsEl.innerHTML = `<div class="coordinator-suggestion-empty">${esc(error.message)}</div>`;
        suggestionsEl.classList.remove('hidden');
      }
    }, 250);
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.coordinator-destination-field')) suggestionsEl.classList.add('hidden');
  });
  requestForm.addEventListener('submit', requestTrip);
  modalCloseEl.addEventListener('click', closeModal);
  document.querySelector('[data-close-coordinator-modal]').addEventListener('click', closeModal);
  logoutEl.addEventListener('click', () => auth.signOut());

  window.startCoordinatorDispatch = startCoordinatorDispatch;
  window.stopCoordinatorDispatch = stopCoordinatorDispatch;
})();
