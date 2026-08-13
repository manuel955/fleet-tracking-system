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

  // Mapbox no siempre tiene indexados los complejos deportivos y sus puertas.
  // Estas coincidencias locales evitan que "videna" se confunda con calles
  // parecidas como Viena, Wide o Vides.
  const knownVidenaPlaces = [
    { id: 'known-videna', aliases: ['videna', 'villa deportiva nacional'], label: 'Villa Deportiva Nacional (VIDENA) · San Luis, Lima', lat: -12.0806801, lng: -77.0030403 },
    { id: 'known-videna-puerta-1', aliases: ['videna puerta 1', 'puerta 1 videna', 'villa deportiva nacional puerta 1'], label: 'VIDENA · Puerta 1 · Av. del Aire cdra. 8 s/n, San Luis, Lima', lat: -12.0806801, lng: -77.0030403 },
    { id: 'known-videna-puerta-2', aliases: ['videna puerta 2', 'puerta 2 videna'], label: 'VIDENA · Puerta 2 · Av. del Aire, San Luis, Lima', lat: -12.0800089, lng: -77.0014494 },
    { id: 'known-videna-puerta-4', aliases: ['videna puerta 4', 'puerta 4 videna', 'villa deportiva nacional puerta 4'], label: 'VIDENA · Puerta 4 · Av. del Aire s/n, San Luis, Lima', lat: -12.0811262, lng: -77.0030219 },
    { id: 'known-videna-puerta-6', aliases: ['videna puerta 6', 'puerta 6 videna'], label: 'VIDENA · Puerta 6 · Av. San Luis 1180, San Luis, Lima', lat: -12.0789240, lng: -76.9988799 },
    { id: 'known-videna-puerta-7', aliases: ['videna puerta 7', 'puerta 7 videna'], label: 'VIDENA · Puerta 7 · Av. San Luis, San Luis, Lima', lat: -12.0800930, lng: -76.9983900 },
    { id: 'known-videna-puerta-12', aliases: ['videna puerta 12', 'puerta 12 videna'], label: 'VIDENA · Puerta 12 · Av. Canadá, San Luis, Lima', lat: -12.0832330, lng: -76.9998650 },
    { id: 'known-videna-puerta-13', aliases: ['videna puerta 13', 'puerta 13 videna'], label: 'VIDENA · Puerta 13 · Av. Aviación, San Luis, Lima', lat: -12.0824257, lng: -77.0040621 },
    { id: 'known-videna-puerta-14', aliases: ['videna puerta 14', 'puerta 14 videna'], label: 'VIDENA · Puerta 14 · Av. Aviación, San Luis, Lima', lat: -12.0818306, lng: -77.0045532 },
  ];

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
  let tripMap = null;
  let tripMapReady = false;
  let tripDriverMarker = null;
  let tripPickupMarker = null;
  let tripDestinationMarker = null;
  let tripRoute = null;
  let tripMapFocusKey = '';
  let tripMapRequestToken = 0;
  let tripDetailTimer = null;
  let coordinatorPollTimer = null;
  let coordinatorPollInFlight = false;
  let tripDetailInFlight = false;
  let modalTripStatus = null;
  let modalTripDetail = null;
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
    const vpsBase = String(window.vpsApiBaseUrl || '').replace(/\/$/, '');
    const useVpsCoordinator = Boolean(vpsBase && auth.currentUser?.isVpsSession);
    const detailMatch = path.match(/^getCoordinatorTripDetail\?tripId=(.+)$/);
    let requestUrl = `${functionsBase}/${path}`;
    let requestPayload = payload;
    if (useVpsCoordinator) {
      if (path === 'listCoordinatorTrips' || path === 'createCoordinatorTrip') {
        requestUrl = `${vpsBase}/api/v1/dashboard/coordinator/trips`;
      } else if (path === 'cancelCoordinatorTrip') {
        requestUrl = `${vpsBase}/api/v1/dashboard/coordinator/trips/${encodeURIComponent(payload?.tripId || '')}/cancel`;
        requestPayload = payload?.reason ? { reason: payload.reason } : {};
      } else if (detailMatch) {
        requestUrl = `${vpsBase}/api/v1/dashboard/coordinator/trips/${decodeURIComponent(detailMatch[1])}`;
      }
    }
    const options = {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    if (requestPayload && (payload || requestUrl.includes('/trips/'))) options.body = JSON.stringify(requestPayload);
    options.signal = AbortSignal.timeout(15000);
    const response = await fetch(requestUrl, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'No se pudo completar la operación.');
    if (useVpsCoordinator && path === 'createCoordinatorTrip' && result.trip) {
      return { ok: true, tripId: result.trip.id, trip: result.trip };
    }
    return result;
  }

  function mapboxToken() {
    return window.DASHBOARD_MAP_CONFIG?.accessToken || window.__MAPBOX_ACCESS_TOKEN__ || '';
  }

  function normalizeSearchText(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function knownDestinationMatches(query) {
    const normalized = normalizeSearchText(query);
    if (!normalized.includes('videna') && !normalized.includes('villa deportiva nacional')) return [];
    const gateMatch = normalized.match(/puerta\s*(\d{1,2})/);
    if (gateMatch) {
      const gate = gateMatch[1];
      const exact = knownVidenaPlaces.filter((place) => place.id.endsWith(`-puerta-${gate}`));
      return exact.length ? exact : [{ id: `known-videna-puerta-${gate}`, label: `VIDENA · Puerta ${gate} · San Luis, Lima`, lat: -12.0806801, lng: -77.0030403 }];
    }
    return knownVidenaPlaces;
  }

  async function searchDestinations(query) {
    const known = knownDestinationMatches(query);
    if (known.length) return known;
    const token = mapboxToken();
    if (!token || query.trim().length < 3) return [];
    const proximity = coordinatorPlace
      ? `&proximity=${coordinatorPlace.lng},${coordinatorPlace.lat}`
      : '';
    const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(query.trim())}&autocomplete=true&limit=8&language=es&country=pe${proximity}&permanent=false&access_token=${encodeURIComponent(token)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
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

  function tripVehicleIcon(status) {
    const color = status === 'in_progress' ? '#78A7FF' : '#F5B94C';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="46" height="46" viewBox="0 0 46 46"><circle cx="23" cy="23" r="20" fill="#081618" stroke="#fff" stroke-width="3"/><path d="M12 26.5 14.5 18c.3-1.1 1.3-1.8 2.4-1.8h12.2c1.1 0 2.1.7 2.4 1.8l2.5 8.5v5H12v-5Z" fill="${color}"/><path d="M16.5 19.5h13l-1.5-3h-10z" fill="#fff" opacity=".88"/><circle cx="17" cy="31" r="2.2" fill="#081618"/><circle cx="29" cy="31" r="2.2" fill="#081618"/><path d="M14 26h18" stroke="#081618" stroke-width="1.5" opacity=".7"/></svg>`;
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      width: 46,
      height: 46,
    };
  }

  function tripPoint(lat, lng) {
    const point = { lat: Number(lat), lng: Number(lng) };
    return isValidPoint(point) ? point : null;
  }

  function syncTripMarker(marker, position, icon, title) {
    if (!position || !tripMap) {
      if (marker) marker.setMap(null);
      return null;
    }
    if (!marker) {
      return tripMap.createMarker({
        position,
        icon,
        title,
        map: tripMap,
      });
    }
    marker.setPosition(position, { durationMs: 0 });
    marker.setIcon(icon);
    marker.setMap(tripMap);
    return marker;
  }

  function clearTripRoute() {
    if (tripRoute) tripRoute.setMap(null);
    tripRoute = null;
  }

  function destroyTripMap() {
    tripMapRequestToken += 1;
    clearTripRoute();
    [tripDriverMarker, tripPickupMarker, tripDestinationMarker].forEach((marker) => {
      if (marker) marker.setMap(null);
    });
    tripDriverMarker = null;
    tripPickupMarker = null;
    tripDestinationMarker = null;
    if (tripMap?.remove) tripMap.remove();
    tripMap = null;
    tripMapReady = false;
    tripMapFocusKey = '';
  }

  function updateTripMapCaption(trip, detail) {
    const captionEl = document.getElementById('coordinator-trip-map-caption');
    const statusEl = document.getElementById('coordinator-trip-map-status');
    if (!captionEl || !statusEl) return;
    const badgeEl = document.querySelector('.coordinator-trip-map-badge');
    const terminal = isTerminalTripStatus(trip.status);
    if (badgeEl) {
      badgeEl.textContent = terminal ? 'FINALIZADO' : 'EN VIVO';
      badgeEl.classList.toggle('terminal', terminal);
    }
    if (terminal) {
      const cancelled = trip.status === 'cancelled';
      statusEl.textContent = cancelled ? 'Viaje cancelado' : 'Viaje completado';
      captionEl.textContent = cancelled
        ? 'Seguimiento detenido. Este viaje fue cancelado.'
        : 'Seguimiento finalizado. Este viaje fue completado.';
      return;
    }
    const driver = detail?.driverLocation;
    const targetIsDestination = trip.status === 'in_progress';
    const targetLabel = targetIsDestination ? 'destino' : 'punto de recogida';
    const targetAddress = targetIsDestination ? trip.destinationAddress : trip.pickupAddress;
    if (!driver) {
      statusEl.textContent = 'Esperando ubicación del vehículo';
      captionEl.textContent = `El mapa mostrará el vehículo cuando el conductor transmita GPS. Destino actual: ${targetAddress || targetLabel}.`;
      return;
    }
    const lastUpdate = Number(driver.lastUpdate || 0);
    const time = lastUpdate > 0
      ? new Date(lastUpdate).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : 'ahora';
    statusEl.textContent = 'Ubicación del vehículo actualizada';
    captionEl.textContent = `Vehículo en ruta al ${targetLabel}: ${targetAddress || 'ubicación indicada'} · GPS ${time}.`;
  }

  function focusTripMap(points, trip, hasDriver) {
    if (!tripMap || points.length === 0) return;
    const target = trip.status === 'in_progress' ? tripPoint(trip.destinationLat, trip.destinationLng) : tripPoint(trip.pickupLat, trip.pickupLng);
    const focusKey = [
      trip.status,
      hasDriver ? 'vehicle' : 'waiting',
      target ? `${target.lat.toFixed(4)},${target.lng.toFixed(4)}` : 'no-target',
      tripPoint(trip.destinationLat, trip.destinationLng) ? 'destination' : 'no-destination',
    ].join('|');
    if (focusKey === tripMapFocusKey) return;
    tripMapFocusKey = focusKey;
    if (points.length === 1) {
      tripMap.setView(points[0], 15);
      return;
    }
    const bounds = new window.mapboxgl.LngLatBounds();
    points.forEach((point) => bounds.extend([point.lng, point.lat]));
    tripMap.fitBounds(bounds, { padding: 42, maxZoom: 15 });
  }

  async function updateTripMap(trip, detail) {
    if (!tripMap || !tripMapReady) return;
    const requestToken = ++tripMapRequestToken;
    const terminal = isTerminalTripStatus(trip.status);
    const pickup = tripPoint(trip.pickupLat, trip.pickupLng);
    const destination = tripPoint(trip.destinationLat, trip.destinationLng);
    const driver = terminal ? null : tripPoint(detail?.driverLocation?.lat, detail?.driverLocation?.lng);
    const target = terminal ? null : (trip.status === 'in_progress' ? destination : pickup);

    tripDriverMarker = syncTripMarker(tripDriverMarker, driver, tripVehicleIcon(trip.status), 'Ubicación del vehículo');
    tripPickupMarker = syncTripMarker(tripPickupMarker, pickup, previewIcon('#1d4ed8', 'P'), 'Punto de recogida');
    tripDestinationMarker = syncTripMarker(tripDestinationMarker, destination, previewIcon('#7c3aed', 'D'), 'Destino');
    updateTripMapCaption(trip, detail);

    if (driver && target) {
      try {
        const route = await tripMap.computeRoute(driver, target);
        if (requestToken !== tripMapRequestToken || !tripMapReady) return;
        if (Array.isArray(route?.path) && route.path.length >= 2) {
          if (!tripRoute) {
            tripRoute = tripMap.createPolyline({
              path: route.path,
              map: tripMap,
              strokeColor: '#081618',
              strokeWeight: 5,
            });
          } else {
            tripRoute.setPath(route.path);
          }
        } else {
          clearTripRoute();
        }
      } catch (_) {
        if (requestToken === tripMapRequestToken) clearTripRoute();
      }
    } else {
      clearTripRoute();
    }

    if (requestToken !== tripMapRequestToken || !tripMapReady) return;
    focusTripMap(
      [driver, pickup, destination].filter(Boolean),
      trip,
      Boolean(driver),
    );
  }

  function initTripMap() {
    const mapEl = document.getElementById('coordinator-trip-map');
    if (!mapEl || !window.MapboxMapAdapter) return;
    const trip = selectedTripId ? trips[selectedTripId] : null;
    const center = tripPoint(trip?.pickupLat, trip?.pickupLng) || { lat: -12.0464, lng: -77.0428 };
    try {
      const mapInstance = new window.MapboxMapAdapter({ container: mapEl, center, zoom: 13 });
      tripMap = mapInstance;
      mapInstance.ready.then(() => {
        if (tripMap !== mapInstance) return;
        tripMapReady = true;
        tripMap.resize();
        const liveTrip = selectedTripId ? trips[selectedTripId] : null;
        if (liveTrip) updateTripMap(liveTrip, modalTripDetail);
      }).catch(() => {
        const statusEl = document.getElementById('coordinator-trip-map-status');
        const captionEl = document.getElementById('coordinator-trip-map-caption');
        if (statusEl) statusEl.textContent = 'Mapa no disponible';
        if (captionEl) captionEl.textContent = 'No se pudo cargar el mapa de seguimiento.';
      });
    } catch (_) {
      const statusEl = document.getElementById('coordinator-trip-map-status');
      const captionEl = document.getElementById('coordinator-trip-map-caption');
      if (statusEl) statusEl.textContent = 'Mapa no disponible';
      if (captionEl) captionEl.textContent = 'No se pudo inicializar el mapa de seguimiento.';
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

  function isTerminalTripStatus(status) {
    return ['completed', 'cancelled'].includes(status);
  }

  function renderModal(trip, detail, etaLabel = 'Consultando…') {
    const phone = String(trip.driverPhone || '').replace(/[^+\d]/g, '');
    const phoneLink = phone ? `<a href="tel:${esc(phone)}">${esc(trip.driverPhone)}</a>` : '—';
    const terminal = isTerminalTripStatus(trip.status);
    const displayedEta = terminal && etaLabel === 'Consultando…' ? '—' : etaLabel;
    const etaTarget = trip.status === 'in_progress' ? 'hasta el destino' : 'hasta la sede';
    modalTitleEl.textContent = `Viaje ${String(selectedTripId || '').slice(-8)}`;
    modalContentEl.innerHTML = `
      <div class="coordinator-modal-status"><span class="coordinator-status-pill ${statusClasses[trip.status] || ''}"><i></i>${esc(statusLabel(trip.status))}</span><span>${esc(formatTime(trip.requestedAt))}</span></div>
      <div class="coordinator-trip-map-block">
        <div class="coordinator-trip-map-heading">
          <div><h3>Seguimiento del vehículo</h3><small id="coordinator-trip-map-status">Consultando ubicación</small></div>
          <span class="coordinator-trip-map-badge${terminal ? ' terminal' : ''}">${terminal ? 'FINALIZADO' : 'EN VIVO'}</span>
        </div>
        <div id="coordinator-trip-map" class="coordinator-trip-map" aria-label="Mapa del viaje"></div>
        <div class="coordinator-trip-map-legend"><span><i class="vehicle"></i>Vehículo</span><span><i class="pickup"></i>Recogida</span><span><i class="destination"></i>Destino</span></div>
        <p id="coordinator-trip-map-caption" class="coordinator-trip-map-caption">Cargando mapa del viaje…</p>
      </div>
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
        ${driverField(trip, detail, 'ETA', `<span id="coordinator-modal-eta">${esc(displayedEta)}${trip.driverId && !terminal && displayedEta !== '—' ? ` <small>${esc(etaTarget)}</small>` : ''}</span>`)}
      </div>
    `;
    modalActionsEl.innerHTML = canCancel(trip)
      ? '<button type="button" id="coordinator-cancel-trip" class="coordinator-danger-btn">Cancelar viaje</button>'
      : '';
    const cancelButton = document.getElementById('coordinator-cancel-trip');
    if (cancelButton) cancelButton.addEventListener('click', () => cancelTrip(selectedTripId));
  }

  async function fetchEta(trip, detail) {
    if (isTerminalTripStatus(trip.status)) return '—';
    if (!trip.driverId || !detail?.driverLocation) return '—';
    const target = trip.status === 'in_progress'
      ? { lat: Number(trip.destinationLat), lng: Number(trip.destinationLng) }
      : { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) };
    if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) return '—';
    const token = mapboxToken();
    if (!token) return 'No disponible';
    const origin = detail.driverLocation;
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${origin.lng},${origin.lat};${target.lng},${target.lat}?overview=false&access_token=${encodeURIComponent(token)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return 'No disponible';
    const route = (await response.json()).routes?.[0];
    if (!route || !Number.isFinite(Number(route.duration))) return 'No disponible';
    const minutes = Math.round(Number(route.duration) / 60);
    return minutes < 1 ? 'Menos de 1 min' : `${minutes} min`;
  }

  async function refreshSelectedTripDetail() {
    const tripId = selectedTripId;
    if (!tripId || tripDetailInFlight) return;
    const trip = trips[tripId];
    if (!trip) return;
    tripDetailInFlight = true;
    const requestToken = modalRequestToken;
    try {
      const detail = await coordinatorRequest(`getCoordinatorTripDetail?tripId=${encodeURIComponent(tripId)}`);
      const viewTrip = detail?.trip || trips[tripId] || trip;
      const eta = await fetchEta(viewTrip, detail);
      if (requestToken !== modalRequestToken || selectedTripId !== tripId) return;
      if (isTerminalTripStatus(viewTrip.status) && tripDetailTimer) {
        clearInterval(tripDetailTimer);
        tripDetailTimer = null;
      }
      modalTripDetail = detail;
      const shouldRender = modalTripStatus !== viewTrip.status || !document.getElementById('coordinator-trip-map');
      if (shouldRender) {
        destroyTripMap();
        renderModal(viewTrip, detail, eta);
        modalTripStatus = viewTrip.status;
        initTripMap();
      } else {
        const etaEl = document.getElementById('coordinator-modal-eta');
        if (etaEl) {
          const etaTarget = viewTrip.status === 'in_progress' ? 'hasta el destino' : 'hasta la sede';
          etaEl.innerHTML = `${esc(eta)}${viewTrip.driverId && eta !== '—' ? ` <small>${esc(etaTarget)}</small>` : ''}`;
        }
      }
      if (tripMapReady) await updateTripMap(viewTrip, detail);
    } catch (_) {
      // Conserva el ultimo mapa valido si una consulta puntual falla.
    } finally {
      tripDetailInFlight = false;
    }
  }

  function openTripModal(tripId) {
    const trip = trips[tripId];
    if (!trip) return;
    if (tripDetailTimer) clearInterval(tripDetailTimer);
    selectedTripId = tripId;
    modalRequestToken += 1;
    modalTripStatus = trip.status;
    modalTripDetail = null;
    destroyTripMap();
    modalEl.classList.remove('hidden');
    modalEl.setAttribute('aria-hidden', 'false');
    renderModal(trip, null);
    initTripMap();
    refreshSelectedTripDetail();
    if (!isTerminalTripStatus(trip.status)) {
      tripDetailTimer = setInterval(refreshSelectedTripDetail, 5000);
    }
  }

  function closeModal() {
    if (tripDetailTimer) clearInterval(tripDetailTimer);
    tripDetailTimer = null;
    selectedTripId = null;
    modalRequestToken += 1;
    modalTripStatus = null;
    modalTripDetail = null;
    destroyTripMap();
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
      const result = await coordinatorRequest('cancelCoordinatorTrip', { tripId });
      if (result?.trip) trips[tripId] = { ...trips[tripId], ...result.trip, status: 'cancelled' };
      renderTrips();
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
    if (coordinatorPollTimer) clearInterval(coordinatorPollTimer);
    tripListenerRef = null;
    if (window.vpsApiBaseUrl && auth.currentUser?.isVpsSession) {
      const refresh = async () => {
        if (coordinatorPollInFlight) return;
        coordinatorPollInFlight = true;
        try {
          const result = await coordinatorRequest('listCoordinatorTrips');
          trips = Object.fromEntries((result.trips || []).map((trip) => [trip.id, trip]));
          renderTrips();
          if (selectedTripId && trips[selectedTripId]) refreshSelectedTripDetail();
        } catch (_) {
          // Keep the last successful snapshot visible during a short outage.
        } finally {
          coordinatorPollInFlight = false;
        }
      };
      refresh();
      coordinatorPollTimer = setInterval(refresh, 5000);
      return;
    }
    tripListenerRef = db.ref(`coordinatorTrips/${coordinatorUser.uid}`);
    tripListenerRef.on('value', (snapshot) => {
      trips = snapshot.val() || {};
      renderTrips();
      if (selectedTripId && trips[selectedTripId]) refreshSelectedTripDetail();
    });
  }

  function stopCoordinatorDispatch() {
    if (tripListenerRef) tripListenerRef.off();
    tripListenerRef = null;
    if (coordinatorPollTimer) clearInterval(coordinatorPollTimer);
    coordinatorPollTimer = null;
    coordinatorPollInFlight = false;
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

  async function hydrateCoordinatorPlace(user, claims) {
    const token = await user.getIdToken();
    let sourceUser = null;
    try {
      const response = await fetch(`${String(window.vpsApiBaseUrl || '').replace(/\/$/, '')}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) sourceUser = payload.user || null;
    } catch (_) {
      // Firebase-only legacy sessions may not be accepted by the VPS during
      // a brief migration outage; their custom claims remain the fallback.
    }
    let next = {
      ...claims,
      ...(sourceUser ? {
        sedeId: sourceUser.sedeId,
        sedeType: sourceUser.sedeType,
        sedeName: sourceUser.sedeName,
        sedeAddress: sourceUser.sedeAddress,
        sedeLat: sourceUser.sedeLat,
        sedeLng: sourceUser.sedeLng,
      } : {}),
    };
    if ((!Number.isFinite(Number(next.sedeLat)) || !Number.isFinite(Number(next.sedeLng)))
      && window.vpsConfigApi && next.sedeId) {
      try {
        const config = await window.vpsConfigApi.publicConfig();
        const lists = config?.places || {};
        const candidates = [...(lists.hotels || []), ...(lists.sportVenues || [])];
        const place = candidates.find((entry) => String(entry.id) === String(next.sedeId));
        if (place) {
          next = {
            ...next,
            sedeName: place.name,
            sedeAddress: place.address,
            sedeLat: Number(place.lat),
            sedeLng: Number(place.lng),
            sedeType: place.category === 'hotels' ? 'hotel' : 'sportVenue',
          };
        }
      } catch (_) {
        // Keep the panel usable; the API will still validate the actual sede.
      }
    }
    const hasPlace = Number.isFinite(Number(next.sedeLat)) && Number.isFinite(Number(next.sedeLng));
    if (!hasPlace || !started || coordinatorUser?.uid !== user.uid) return;
    coordinatorClaims = next;
    coordinatorPlace = {
      id: String(next.sedeId || ''),
      type: String(next.sedeType || ''),
      name: String(next.sedeName || 'Sede asignada'),
      address: String(next.sedeAddress || ''),
      lat: Number(next.sedeLat),
      lng: Number(next.sedeLng),
    };
    placeNameEl.textContent = coordinatorPlace.name;
    originInput.value = coordinatorPlace.address
      ? `${coordinatorPlace.name} · ${coordinatorPlace.address}`
      : coordinatorPlace.name;
    originInput.title = coordinatorPlace.address || coordinatorPlace.name;
    initPreviewMap();
    updateDestinationPreview();
  }

  function startCoordinatorDispatch(user, claims = {}) {
    if (started && coordinatorUser?.uid === user.uid
      && String(coordinatorClaims.sedeId || '') === String(claims.sedeId || '')
      && Number(coordinatorClaims.sedeLat) === Number(claims.sedeLat)
      && Number(coordinatorClaims.sedeLng) === Number(claims.sedeLng)) return;
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
    void hydrateCoordinatorPlace(user, claims);
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
