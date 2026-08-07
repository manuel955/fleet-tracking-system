const DRIVER_HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000;

function hasHeartbeatExpired(lastHeartbeat, now = Date.now()) {
  const heartbeat = Number(lastHeartbeat);
  return Number.isFinite(heartbeat) && heartbeat > 0 && now - heartbeat > DRIVER_HEARTBEAT_TIMEOUT_MS;
}

// Al iniciar un turno se conserva la ultima posicion del turno anterior para
// no perder el ultimo punto visible en el mapa. Ese valor no puede servir como
// heartbeat del turno nuevo: hasta que llega el primer GPS, el servidor debe
// contar desde `gpsSessionStartedAt` y no desde una ubicacion vieja.
function effectiveDriverHeartbeat(driver) {
  const currentLocation = Number(driver?.lastUpdate || 0);
  const sessionStarted = Number(driver?.gpsSessionStartedAt || 0);
  if (sessionStarted > 0 && (!currentLocation || currentLocation < sessionStarted)) {
    return sessionStarted;
  }
  return currentLocation || Number(driver?.ultima_conexion || 0);
}

// El turno y la conexion son estados distintos: un conductor puede conservar
// el turno abierto mientras la app recupera el servicio GPS. El endpoint de
// ubicacion debe usar esta regla unica para no rechazar puntos validos por un
// `status` viejo o nulo.
function isDriverShiftActive(driver) {
  return driver?.turno_activo === true ||
    driver?.status === 'online' ||
    driver?.status === 'busy';
}

module.exports = {
  DRIVER_HEARTBEAT_TIMEOUT_MS,
  effectiveDriverHeartbeat,
  hasHeartbeatExpired,
  isDriverShiftActive,
};
