/* global mapboxgl */
(function (global) {
  'use strict';

  const config = global.DASHBOARD_MAP_CONFIG || {};

  function pointToArray(point) {
    return [Number(point.lng), Number(point.lat)];
  }

  function asGeoJsonLine(points) {
    return {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: points.map(pointToArray),
      },
    };
  }

  class MapboxMarkerHandle {
    constructor(adapter, options = {}) {
      this.adapter = adapter;
      this.element = document.createElement('div');
      this.element.className = 'mapbox-domain-marker';
      this.element.setAttribute('role', 'button');
      this.marker = new mapboxgl.Marker({
        element: this.element,
        anchor: options.anchor || 'center',
        clickTolerance: 4,
      });
      this._positionAnimationFrame = null;
      this._targetPosition = null;
      this._hasPosition = false;
      this.setIcon(options.icon);
      this.setOpacity(options.opacity == null ? 1 : options.opacity);
      if (options.title) this.element.title = options.title;
      this.setPosition(options.position || { lat: 0, lng: 0 }, { durationMs: 0 });
      if (options.map) this.setMap(options.map);
    }

    setPosition(position, { durationMs = 5000 } = {}) {
      const target = pointToArray(position);
      const currentTarget = this._targetPosition;
      if (currentTarget && currentTarget[0] === target[0] && currentTarget[1] === target[1]) {
        return this;
      }

      const current = this.marker.getLngLat();
      this._targetPosition = target;
      this._cancelPositionAnimation();
      if (!this._hasPosition || durationMs <= 0 || !current) {
        this.marker.setLngLat(target);
        this._hasPosition = true;
        return this;
      }

      const start = { lng: current.lng, lat: current.lat };
      const startedAt = performance.now();
      const animate = (now) => {
        if (!this._targetPosition || this._targetPosition !== target) return;
        const progress = Math.min(1, (now - startedAt) / durationMs);
        this.marker.setLngLat([
          start.lng + (target[0] - start.lng) * progress,
          start.lat + (target[1] - start.lat) * progress,
        ]);
        if (progress < 1) {
          this._positionAnimationFrame = requestAnimationFrame(animate);
        } else {
          this._positionAnimationFrame = null;
        }
      };
      this._positionAnimationFrame = requestAnimationFrame(animate);
      return this;
    }

    _cancelPositionAnimation() {
      if (this._positionAnimationFrame != null) {
        cancelAnimationFrame(this._positionAnimationFrame);
        this._positionAnimationFrame = null;
      }
    }

    getPosition() {
      const position = this.marker.getLngLat();
      return { lat: position.lat, lng: position.lng };
    }

    setIcon(icon) {
      const width = Number(icon?.width || icon?.scaledSize?.width || 36);
      const height = Number(icon?.height || icon?.scaledSize?.height || width);
      this.element.style.width = `${width}px`;
      this.element.style.height = `${height}px`;
      this.element.style.backgroundRepeat = 'no-repeat';
      this.element.style.backgroundPosition = 'center';
      this.element.style.backgroundSize = 'contain';
      this.element.style.backgroundImage = icon?.url ? `url("${icon.url}")` : '';
      this.element.style.backgroundColor = icon?.color || 'transparent';
      return this;
    }

    setOpacity(opacity) {
      this.element.style.opacity = String(opacity);
      return this;
    }

    addListener(eventName, callback) {
      this.element.addEventListener(eventName, callback);
      return {
        remove: () => this.element.removeEventListener(eventName, callback),
      };
    }

    setMap(map) {
      if (map && map._map) this.marker.addTo(map._map);
      else {
        this._cancelPositionAnimation();
        this.marker.remove();
      }
      return this;
    }
  }

  class MapboxPolylineHandle {
    constructor(adapter, options = {}) {
      this.adapter = adapter;
      this.id = `domain-route-${++adapter.routeSequence}`;
      this.path = options.path || [];
      this.color = options.strokeColor || '#000000';
      this.width = Number(options.strokeWeight || 5);
      if (options.map) this.setMap(options.map);
    }

    setPath(path) {
      this.path = path || [];
      if (this.adapter && this.map) this.adapter._updatePolyline(this);
      return this;
    }

    setMap(map) {
      if (this.map && !map) this.adapter._removePolyline(this);
      this.map = map || null;
      if (this.map) this.adapter._updatePolyline(this);
      return this;
    }
  }

  class MapboxMapAdapter {
    constructor({ container, center, zoom }) {
      if (!global.mapboxgl) throw new Error('Mapbox GL JS no esta disponible');
      if (!config.accessToken) throw new Error('MAPBOX_ACCESS_TOKEN no configurado');
      mapboxgl.accessToken = config.accessToken;
      this.routeSequence = 0;
      this._routeCache = new Map();
      this._routeRequests = new Map();
      this._matrixCache = new Map();
      this._geocodeCache = new Map();
      this._map = new mapboxgl.Map({
        container,
        style: config.style || 'mapbox://styles/mapbox/standard',
        center: pointToArray(center),
        zoom,
        attributionControl: true,
        cooperativeGestures: false,
      });
      this.ready = new Promise((resolve, reject) => {
        let loaded = false;
        this._map.once('load', () => {
          loaded = true;
          resolve(this);
        });
        this._map.on('error', (event) => {
          if (!loaded && event?.error) reject(event.error);
        });
      });
    }

    panTo(position) {
      this._map.easeTo({ center: pointToArray(position), duration: 450 });
    }

    setCenter(position) {
      this._map.easeTo({ center: pointToArray(position), duration: 450 });
    }

    setView(position, zoom) {
      this._map.easeTo({ center: pointToArray(position), zoom, duration: 450 });
    }

    setZoom(zoom) {
      this._map.easeTo({ zoom, duration: 350 });
    }

    getZoom() {
      return this._map.getZoom();
    }

    fitBounds(bounds, options = {}) {
      const padding = typeof options === 'number' ? options : (options.padding || 72);
      this._map.fitBounds(bounds, { padding, maxZoom: options.maxZoom || 16 });
    }

    once(eventName, callback) {
      this._map.once(eventName, callback);
    }

    resize() {
      this._map.resize();
    }

    remove() {
      this._map.remove();
    }

    createMarker(options) {
      return new MapboxMarkerHandle(this, options);
    }

    createPolyline(options) {
      return new MapboxPolylineHandle(this, options);
    }

    _updatePolyline(line) {
      if (!line.map || line.path.length < 2) return;
      const sourceId = `${line.id}-source`;
      const layerId = `${line.id}-layer`;
      const data = asGeoJsonLine(line.path);
      if (this._map.getSource(sourceId)) {
        this._map.getSource(sourceId).setData(data);
        return;
      }
      this._map.addSource(sourceId, { type: 'geojson', data });
      this._map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': line.color,
          'line-opacity': 0.85,
          'line-width': line.width,
        },
      });
    }

    _removePolyline(line) {
      const sourceId = `${line.id}-source`;
      const layerId = `${line.id}-layer`;
      try {
        if (this._map.getLayer(layerId)) this._map.removeLayer(layerId);
        if (this._map.getSource(sourceId)) this._map.removeSource(sourceId);
      } catch (_) {}
    }

    async computeRoute(origin, destination) {
      const token = config.accessToken;
      const key = [origin, destination]
        .map((point) => `${Number(point.lat).toFixed(4)},${Number(point.lng).toFixed(4)}`)
        .join('|');
      const now = Date.now();
      const cached = this._routeCache.get(key);
      if (cached && cached.expiresAt > now) return cached.value;
      const pending = this._routeRequests.get(key);
      if (pending) return pending;

      const coordinates = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
      const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}`);
      url.search = new URLSearchParams({
        access_token: token,
        geometries: 'geojson',
        overview: 'full',
        steps: 'true',
        language: 'es',
      }).toString();
      const request = (async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(`Mapbox Directions ${response.status}`);
        const data = await response.json();
        const route = data.routes?.[0];
        const coordinatesData = route?.geometry?.coordinates;
        if (!Array.isArray(coordinatesData) || coordinatesData.length < 2) {
          throw new Error('Mapbox Directions: sin rutas');
        }
        return {
          path: coordinatesData.map(([lng, lat]) => ({ lat, lng })),
          durationSeconds: Number.isFinite(route.duration) ? route.duration : null,
        };
      })();
      this._routeRequests.set(key, request);
      try {
        const value = await request;
        this._routeCache.set(key, { value, expiresAt: now + 30_000 });
        return value;
      } finally {
        this._routeRequests.delete(key);
      }
    }

    async computeMatrix(points, { sources, destinations } = {}) {
      if (!Array.isArray(points) || points.length < 2) return null;
      if (points.length > 10) throw new Error('Mapbox Matrix admite maximo 10 coordenadas');
      const key = JSON.stringify({
        points: points.map((point) => [Number(point.lat).toFixed(4), Number(point.lng).toFixed(4)]),
        sources: sources || null,
        destinations: destinations || null,
      });
      const cached = this._matrixCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const coordinates = points.map((point) => `${point.lng},${point.lat}`).join(';');
      const url = new URL(`https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coordinates}`);
      url.search = new URLSearchParams({
        access_token: config.accessToken,
        annotations: 'duration,distance',
        ...(sources ? { sources: sources.join(';') } : {}),
        ...(destinations ? { destinations: destinations.join(';') } : {}),
      }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`Mapbox Matrix ${response.status}`);
      const value = await response.json();
      this._matrixCache.set(key, { value, expiresAt: Date.now() + 30_000 });
      return value;
    }

    async geocodeAddress(address) {
      const key = String(address || '').trim().toLowerCase();
      const cached = this._geocodeCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const url = new URL('https://api.mapbox.com/search/geocode/v6/forward');
      url.search = new URLSearchParams({
        q: address,
        autocomplete: 'false',
        limit: '1',
        language: 'es',
        country: 'pe',
        // Siempre temporal: no habilitar almacenamiento permanente de
        // resultados ni el SKU de Geocodificación Permanente.
        permanent: 'false',
        access_token: config.accessToken,
      }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Mapbox Geocoding ${response.status}`);
      const data = await response.json();
      const coordinates = data.features?.[0]?.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        throw new Error('Mapbox Geocoding: direccion no encontrada');
      }
      const value = { lng: Number(coordinates[0]), lat: Number(coordinates[1]) };
      this._geocodeCache.set(key, { value, expiresAt: Date.now() + 10 * 60_000 });
      return value;
    }
  }

  global.MapboxMapAdapter = MapboxMapAdapter;
})(window);
