const {
  effectiveDriverHeartbeat,
  hasHeartbeatExpired,
  isDriverShiftActive,
} = require('./heartbeat-policy');

function policyError(httpStatus, error) {
  return { ok: false, httpStatus, error };
}

function buildDriverAvailabilityUpdate(current, online, now) {
  if (!current) return policyError(404, 'Conductor no encontrado.');
  if (!online && current.currentTripId) {
    return policyError(409, 'No puedes terminar el turno con un viaje activo.');
  }
  if (online && current.approvalStatus !== 'approved') {
    return policyError(403, 'El conductor todavía no está aprobado.');
  }

  const publicStatus = online
    ? (current.currentTripId ? 'busy' : 'online')
    : 'offline';
  return {
    ok: true,
    publicStatus,
    value: online
      ? {
        ...current,
        status: publicStatus,
        turno_activo: true,
        estado_conexion: 'ONLINE',
        ultima_conexion: now,
        gpsSessionStartedAt: now,
        gpsReady: false,
        ultimo_motivo_desconexion: null,
      }
      : {
        ...current,
        status: null,
        turno_activo: false,
        estado_conexion: 'OFFLINE',
        ultima_conexion: now,
        gpsSessionStartedAt: null,
        gpsReady: false,
        ultimo_motivo_desconexion: 'MANUAL',
      },
  };
}

function normalizeDriverLocation(rawLocation) {
  const location = {
    lat: Number(rawLocation?.lat),
    lng: Number(rawLocation?.lng),
    heading: Number(rawLocation?.heading ?? 0),
  };
  const valid = Number.isFinite(location.lat)
    && location.lat >= -90 && location.lat <= 90
    && Number.isFinite(location.lng)
    && location.lng >= -180 && location.lng <= 180
    && Number.isFinite(location.heading)
    && location.heading >= 0 && location.heading <= 360
    && !(location.lat === 0 && location.lng === 0);
  return valid ? location : null;
}

function buildDriverLocationUpdate(current, location, lastUpdate) {
  if (!current) return policyError(404, 'Conductor no encontrado.');
  if (current.approvalStatus !== 'approved') {
    return policyError(403, 'El conductor todavía no está aprobado.');
  }
  if (!isDriverShiftActive(current)) {
    return policyError(409, 'El turno del conductor no está activo.');
  }

  return {
    ok: true,
    value: {
      ...current,
      ...location,
      lastUpdate,
      status: current.currentTripId ? 'busy' : 'online',
      turno_activo: true,
      estado_conexion: 'ONLINE',
      ultima_conexion: lastUpdate,
      gpsSessionStartedAt: null,
      gpsReady: true,
      ultimo_motivo_desconexion: null,
    },
  };
}

function buildHeartbeatDisconnectUpdate(current, observedHeartbeat, now) {
  if (!current) return null;
  const stillConnected = current.status === 'online' || current.status === 'busy';
  const currentHeartbeat = effectiveDriverHeartbeat(current);
  if (!stillConnected
      || currentHeartbeat !== observedHeartbeat
      || !hasHeartbeatExpired(currentHeartbeat, now)) {
    return null;
  }

  return {
    // El trigger de conexión también usa ultima_conexion/lastUpdate para su
    // idempotencia. Compartir ese instante evita dos alertas si ambas rutas
    // observan la misma desconexión en distinto orden.
    disconnectedAt: currentHeartbeat,
    value: {
      ...current,
      status: null,
      // La pérdida de heartbeat no equivale a terminar el turno manualmente.
      turno_activo: true,
      estado_conexion: 'OFFLINE',
      // Conserva ultima_conexion como la hora del último ping real.
      gpsReady: false,
      ultimo_motivo_desconexion: 'HEARTBEAT',
    },
  };
}

module.exports = {
  buildDriverAvailabilityUpdate,
  buildDriverLocationUpdate,
  buildHeartbeatDisconnectUpdate,
  normalizeDriverLocation,
};
