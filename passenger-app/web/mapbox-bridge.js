(function (global) {
  'use strict';

  const maps = new Map();

  function emit(id, type, extra) {
    global.dispatchEvent(new CustomEvent('fleet-mapbox-event', {
      detail: JSON.stringify(Object.assign({ id, type }, extra || {})),
    }));
  }

  function colorToCss(value) {
    const number = Number(value) >>> 0;
    const red = (number >>> 16) & 0xff;
    const green = (number >>> 8) & 0xff;
    const blue = number & 0xff;
    return `rgb(${red} ${green} ${blue})`;
  }

  function createMarkerElement(marker) {
    const element = document.createElement('div');
    element.className = 'fleet-mapbox-web-marker';
    element.style.width = '18px';
    element.style.height = '18px';
    element.style.borderRadius = '50%';
    element.style.border = '2px solid #ffffff';
    element.style.background = colorToCss(marker.color);
    element.style.opacity = String(marker.opacity == null ? 1 : marker.opacity);
    element.style.boxShadow = '0 2px 6px rgba(0,0,0,.35)';
    element.style.cursor = marker.draggable ? 'grab' : 'pointer';
    if (marker.title) element.title = marker.title;
    return element;
  }

  function stopMarkerAnimation(marker) {
    if (marker.__fleetAnimationFrame != null) {
      global.cancelAnimationFrame(marker.__fleetAnimationFrame);
      marker.__fleetAnimationFrame = null;
    }
  }

  function animateMarkerTo(marker, lng, lat, durationMs) {
    const target = [Number(lng), Number(lat)];
    const previousTarget = marker.__fleetTarget;
    if (previousTarget && previousTarget[0] === target[0] && previousTarget[1] === target[1]) return;

    const current = marker.getLngLat();
    marker.__fleetTarget = target;
    stopMarkerAnimation(marker);
    if (!current || marker.__fleetHasPosition !== true || durationMs <= 0) {
      marker.setLngLat(target);
      marker.__fleetHasPosition = true;
      return;
    }

    const start = { lng: current.lng, lat: current.lat };
    const startedAt = global.performance.now();
    const animate = (now) => {
      if (marker.__fleetTarget !== target) return;
      const progress = Math.min(1, (now - startedAt) / durationMs);
      marker.setLngLat([
        start.lng + (target[0] - start.lng) * progress,
        start.lat + (target[1] - start.lat) * progress,
      ]);
      if (progress < 1) {
        marker.__fleetAnimationFrame = global.requestAnimationFrame(animate);
      } else {
        marker.__fleetAnimationFrame = null;
      }
    };
    marker.__fleetAnimationFrame = global.requestAnimationFrame(animate);
  }

  global.fleetMapboxCreate = function (id, token, styleUri, lat, lng, zoom, scroll, zoomGestures) {
    if (!token || !global.mapboxgl) {
      emit(id, 'error');
      return;
    }
    if (maps.has(id)) return;
    global.mapboxgl.accessToken = token;
    const map = new global.mapboxgl.Map({
      container: id,
      style: styleUri || 'mapbox://styles/mapbox/standard',
      center: [lng, lat],
      zoom,
      attributionControl: true,
      dragPan: scroll !== false,
      scrollZoom: scroll !== false,
      touchZoomRotate: zoomGestures !== false,
      doubleClickZoom: zoomGestures !== false,
      dragRotate: false,
      pitchWithRotate: false,
    });

    const state = { map, markers: new Map(), routeSourceId: 'fleet-mapbox-route-source', routeLayerId: 'fleet-mapbox-route-layer' };
    maps.set(id, state);

    map.on('load', () => {
      emit(id, 'ready');
    });
    map.on('error', (event) => {
      if (event && event.error) emit(id, 'error');
    });
    map.on('movestart', () => emit(id, 'move_start'));
    map.on('move', () => {
      const center = map.getCenter();
      emit(id, 'move', { lat: center.lat, lng: center.lng, zoom: map.getZoom() });
    });
    map.on('idle', () => emit(id, 'idle'));
    map.on('click', (event) => emit(id, 'tap', { lat: event.lngLat.lat, lng: event.lngLat.lng }));
  };

  global.fleetMapboxUpdate = function (id, payloadJson) {
    const state = maps.get(id);
    if (!state) return;
    let payload;
    try { payload = JSON.parse(payloadJson || '{}'); } catch (_) { return; }
    const incoming = new Map((payload.markers || []).map((marker) => [String(marker.id), marker]));

    for (const [markerId, marker] of state.markers.entries()) {
      if (!incoming.has(markerId)) {
        stopMarkerAnimation(marker);
        marker.remove();
        state.markers.delete(markerId);
      }
    }
    for (const [markerId, data] of incoming.entries()) {
      let marker = state.markers.get(markerId);
      if (!marker) {
        const element = createMarkerElement(data);
        marker = new global.mapboxgl.Marker({ element, draggable: !!data.draggable })
          .setLngLat([data.lng, data.lat])
          .addTo(state.map);
        marker.__fleetHasPosition = true;
        marker.__fleetTarget = [Number(data.lng), Number(data.lat)];
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          emit(id, 'marker_tap', { id: markerId });
        });
        marker.on('dragend', () => {
          const position = marker.getLngLat();
          emit(id, 'marker_dragend', { id: markerId, lat: position.lat, lng: position.lng });
        });
        state.markers.set(markerId, marker);
      } else {
        animateMarkerTo(marker, data.lng, data.lat, 5000);
        marker.setDraggable(!!data.draggable);
        const element = marker.getElement();
        element.style.background = colorToCss(data.color);
        element.style.opacity = String(data.opacity == null ? 1 : data.opacity);
        element.title = data.title || '';
      }
    }

    const route = (payload.polylines || [])[0];
    const sourceId = state.routeSourceId;
    const layerId = state.routeLayerId;
    if (!route || !Array.isArray(route.points) || route.points.length < 2) {
      if (state.map.getLayer(layerId)) state.map.removeLayer(layerId);
      if (state.map.getSource(sourceId)) state.map.removeSource(sourceId);
      return;
    }

    const data = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: route.points.map((point) => [point.lng, point.lat]),
      },
    };
    const source = state.map.getSource(sourceId);
    if (source) {
      source.setData(data);
    } else {
      state.map.addSource(sourceId, { type: 'geojson', data });
      state.map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': colorToCss(route.color),
          'line-opacity': 0.9,
          'line-width': Number(route.width || 4),
        },
      });
    }
  };

  global.fleetMapboxSetCamera = function (id, lat, lng, zoom, animated) {
    const state = maps.get(id);
    if (!state) return;
    const options = { center: [lng, lat] };
    if (zoom != null) options.zoom = zoom;
    if (animated) state.map.easeTo(Object.assign(options, { duration: 450 }));
    else state.map.jumpTo(options);
  };

  global.fleetMapboxResize = function (id) {
    const state = maps.get(id);
    if (state) state.map.resize();
  };

  global.fleetMapboxDestroy = function (id) {
    const state = maps.get(id);
    if (!state) return;
    for (const marker of state.markers.values()) stopMarkerAnimation(marker);
    state.map.remove();
    maps.delete(id);
  };
})(window);
