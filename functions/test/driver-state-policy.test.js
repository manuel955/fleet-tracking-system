const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDriverAvailabilityUpdate,
  buildDriverLocationUpdate,
  buildHeartbeatDisconnectUpdate,
  normalizeDriverLocation,
} = require('../driver-state-policy');
const { DRIVER_HEARTBEAT_TIMEOUT_MS } = require('../heartbeat-policy');

const NOW = 2_000_000;

function approvedDriver(overrides = {}) {
  return {
    approvalStatus: 'approved',
    name: 'Conductor Uno',
    status: null,
    turno_activo: false,
    ...overrides,
  };
}

test('un conductor aprobado inicia turno online con una sesión GPS nueva', () => {
  const result = buildDriverAvailabilityUpdate(approvedDriver(), true, NOW);

  assert.equal(result.ok, true);
  assert.equal(result.publicStatus, 'online');
  assert.equal(result.value.status, 'online');
  assert.equal(result.value.turno_activo, true);
  assert.equal(result.value.gpsSessionStartedAt, NOW);
  assert.equal(result.value.gpsReady, false);
  assert.equal(result.value.name, 'Conductor Uno');
});

test('un conductor con viaje activo reinicia el turno como busy', () => {
  const result = buildDriverAvailabilityUpdate(
    approvedDriver({ currentTripId: 'trip-1' }),
    true,
    NOW,
  );

  assert.equal(result.ok, true);
  assert.equal(result.publicStatus, 'busy');
  assert.equal(result.value.currentTripId, 'trip-1');
});

test('un conductor no aprobado no puede iniciar turno', () => {
  const result = buildDriverAvailabilityUpdate(
    approvedDriver({ approvalStatus: 'pending' }),
    true,
    NOW,
  );

  assert.deepEqual(result, {
    ok: false,
    httpStatus: 403,
    error: 'El conductor todavía no está aprobado.',
  });
});

test('un conductor suspendido no inicia turno ni envía ubicación', () => {
  const driver = approvedDriver({ suspended: true, turno_activo: true });
  const availability = buildDriverAvailabilityUpdate(driver, true, NOW);
  const location = buildDriverLocationUpdate(
    driver,
    { lat: -12.0464, lng: -77.0428, heading: 0 },
    NOW,
  );

  assert.equal(availability.ok, false);
  assert.equal(availability.httpStatus, 403);
  assert.equal(location.ok, false);
  assert.equal(location.httpStatus, 403);
});

test('el turno no puede cerrarse mientras existe un viaje activo', () => {
  const result = buildDriverAvailabilityUpdate(
    approvedDriver({ status: 'busy', currentTripId: 'trip-1' }),
    false,
    NOW,
  );

  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 409);
});

test('el cierre manual distingue turno cerrado de pérdida de heartbeat', () => {
  const result = buildDriverAvailabilityUpdate(
    approvedDriver({ status: 'online', turno_activo: true }),
    false,
    NOW,
  );

  assert.equal(result.ok, true);
  assert.equal(result.publicStatus, 'offline');
  assert.equal(result.value.status, null);
  assert.equal(result.value.turno_activo, false);
  assert.equal(result.value.gpsSessionStartedAt, null);
  assert.equal(result.value.ultimo_motivo_desconexion, 'MANUAL');
});

test('normaliza una ubicación válida y aplica heading cero por defecto', () => {
  assert.deepEqual(normalizeDriverLocation({ lat: '-12.0464', lng: '-77.0428' }), {
    lat: -12.0464,
    lng: -77.0428,
    heading: 0,
  });
});

test('rechaza coordenadas nulas, fuera de rango o con heading inválido', () => {
  assert.equal(normalizeDriverLocation({ lat: 0, lng: 0 }), null);
  assert.equal(normalizeDriverLocation({ lat: 91, lng: -77 }), null);
  assert.equal(normalizeDriverLocation({ lat: -12, lng: 181 }), null);
  assert.equal(normalizeDriverLocation({ lat: -12, lng: -77, heading: 361 }), null);
});

test('un heartbeat GPS conserva la asignación y deja al conductor busy', () => {
  const result = buildDriverLocationUpdate(
    approvedDriver({
      status: null,
      turno_activo: true,
      currentTripId: 'trip-1',
      gpsSessionStartedAt: NOW - 5_000,
    }),
    { lat: -12.0464, lng: -77.0428, heading: 90 },
    NOW,
  );

  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'busy');
  assert.equal(result.value.currentTripId, 'trip-1');
  assert.equal(result.value.lastUpdate, NOW);
  assert.equal(result.value.gpsSessionStartedAt, null);
  assert.equal(result.value.gpsReady, true);
});

test('una ubicación no reactiva un turno cerrado ni un perfil pendiente', () => {
  const location = { lat: -12.0464, lng: -77.0428, heading: 0 };
  const closed = buildDriverLocationUpdate(approvedDriver(), location, NOW);
  const pending = buildDriverLocationUpdate(
    approvedDriver({ approvalStatus: 'pending', turno_activo: true }),
    location,
    NOW,
  );

  assert.equal(closed.httpStatus, 409);
  assert.equal(pending.httpStatus, 403);
});

test('un heartbeat vencido desconecta sin cerrar el turno', () => {
  const lastUpdate = NOW - DRIVER_HEARTBEAT_TIMEOUT_MS - 1;
  const result = buildHeartbeatDisconnectUpdate(
    approvedDriver({
      status: 'online',
      turno_activo: true,
      lastUpdate,
      ultima_conexion: lastUpdate,
      gpsReady: true,
    }),
    lastUpdate,
    NOW,
  );

  assert.equal(result.disconnectedAt, lastUpdate);
  assert.equal(result.value.status, null);
  assert.equal(result.value.turno_activo, true);
  assert.equal(result.value.ultima_conexion, lastUpdate);
  assert.equal(result.value.gpsReady, false);
  assert.equal(result.value.ultimo_motivo_desconexion, 'HEARTBEAT');
});

test('un heartbeat renovado durante la detección no se marca offline', () => {
  const observed = NOW - DRIVER_HEARTBEAT_TIMEOUT_MS - 1;
  const refreshed = buildHeartbeatDisconnectUpdate(
    approvedDriver({ status: 'online', turno_activo: true, lastUpdate: NOW - 1_000 }),
    observed,
    NOW,
  );
  const alreadyOffline = buildHeartbeatDisconnectUpdate(
    approvedDriver({ status: null, turno_activo: true, lastUpdate: observed }),
    observed,
    NOW,
  );

  assert.equal(refreshed, null);
  assert.equal(alreadyOffline, null);
});
