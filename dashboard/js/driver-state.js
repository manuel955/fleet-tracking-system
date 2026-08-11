// Estado visual derivado del perfil operativo y de la frescura del GPS.
// Se mantiene independiente del DOM para poder probar la regla sin cargar
// todo el dashboard.
(function exposeDriverState(global) {
  const STALE_AFTER_MS = 45 * 1000;
  const OFFLINE_AFTER_MS = 3 * 60 * 1000;
  const GPS_START_GRACE_MS = 45 * 1000;
  const CONNECTED_STATUSES = new Set(['online', 'busy']);

  function freshnessStatus(lastUpdate, now = Date.now()) {
    const timestamp = Number(lastUpdate || 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'offline';
    const age = Math.max(0, now - timestamp);
    if (age <= STALE_AFTER_MS) return 'online';
    if (age <= OFFLINE_AFTER_MS) return 'stale';
    return 'offline';
  }

  function driverState(driver, activeTripsCache = {}, now = Date.now()) {
    const d = driver || {};
    // The VPS snapshot exposes `availabilityStatus`, while the legacy
    // Firebase snapshot exposes `status`/`turno_activo`.  Treat both as the
    // same operational signal; otherwise every VPS driver is painted
    // disconnected even while its GPS heartbeat is fresh.
    const operationalStatus = String(
      d.status ?? d.availabilityStatus ?? '',
    ).toLowerCase();
    const operational = d.turno_activo === true ||
      CONNECTED_STATUSES.has(operationalStatus);
    const signalExpired = freshnessStatus(d.lastUpdate, now) === 'offline';
    const hasCoordinates = typeof d.lat === 'number' && typeof d.lng === 'number';
    const sessionStartedAt = Number(d.gpsSessionStartedAt || 0);
    const sessionIsStarting = sessionStartedAt > 0 &&
      now >= sessionStartedAt && now - sessionStartedAt <= GPS_START_GRACE_MS;

    // Un turno activo sin GPS reciente sigue siendo una operación abierta,
    // pero no debe presentarse como desconectada ni como disponible.
    if (operational && (!hasCoordinates || signalExpired)) {
      if (sessionIsStarting) return 'connecting';
      return 'suspended';
    }
    if (!operational) return 'offline';

    if (d.currentTripId) {
      const trip = activeTripsCache[d.currentTripId];
      // Un viaje cerrado nunca debe mantener al auto en ruta. Esta defensa
      // cubre una ventana breve de desincronizacion mientras el backend
      // limpia currentTripId.
      if (trip && (trip.status === 'cancelled' || trip.status === 'completed')) {
      return CONNECTED_STATUSES.has(operationalStatus) ? 'available' : 'offline';
      }
      if (trip && trip.status === 'in_progress') return 'on_trip';
      return 'to_pickup';
    }

    return CONNECTED_STATUSES.has(operationalStatus) ? 'available' : 'offline';
  }

  const api = Object.freeze({ freshnessStatus, driverState });
  global.DriverState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
