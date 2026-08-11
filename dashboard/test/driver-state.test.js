const test = require('node:test');
const assert = require('node:assert/strict');
const { driverState, freshnessStatus } = require('../js/driver-state.js');

const now = 1_000_000;

test('un turno activo sin GPS reciente queda como sin señal, no desconectado', () => {
  const state = driverState({
    status: 'online',
    turno_activo: true,
    lat: -12.1,
    lng: -77.0,
    lastUpdate: now - (16 * 60 * 60 * 1000),
  }, {}, now);

  assert.equal(state, 'suspended');
});

test('un turno recien iniciado queda conectando mientras llega el primer GPS', () => {
  const state = driverState({
    status: 'online',
    turno_activo: true,
    gpsSessionStartedAt: now - 10_000,
    lastUpdate: now - (16 * 60 * 60 * 1000),
  }, {}, now);

  assert.equal(state, 'connecting');
});

test('un conductor con GPS reciente y estado online aparece disponible', () => {
  const state = driverState({
    status: 'online',
    turno_activo: true,
    lat: -12.1,
    lng: -77.0,
    lastUpdate: now - 5_000,
  }, {}, now);

  assert.equal(state, 'available');
  assert.equal(freshnessStatus(now - 5_000, now), 'online');
});

test('un snapshot del VPS con availabilityStatus online aparece disponible', () => {
  const state = driverState({
    availabilityStatus: 'online',
    lat: -12.1,
    lng: -77.0,
    lastUpdate: now - 5_000,
  }, {}, now);

  assert.equal(state, 'available');
});

test('un conductor que terminó turno sigue apareciendo como desconectado', () => {
  const state = driverState({
    status: null,
    turno_activo: false,
    lat: -12.1,
    lng: -77.0,
    lastUpdate: now - 5_000,
  }, {}, now);

  assert.equal(state, 'offline');
});

test('un viaje cancelado no deja al conductor pegado en ruta ni calcula ETA', () => {
  const state = driverState({
    status: 'busy',
    turno_activo: true,
    lat: -12.1,
    lng: -77.0,
    currentTripId: 'trip-cancelled',
    lastUpdate: now - 5_000,
  }, {
    'trip-cancelled': { status: 'cancelled' },
  }, now);

  assert.equal(state, 'available');
});
