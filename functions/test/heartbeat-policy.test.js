const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DRIVER_HEARTBEAT_TIMEOUT_MS,
  effectiveDriverHeartbeat,
  hasHeartbeatExpired,
  isDriverShiftActive,
} = require('../heartbeat-policy');

test('a short pause does not mark a driver heartbeat as expired', () => {
  const now = 1_000_000;
  assert.equal(hasHeartbeatExpired(now - 45_000, now), false);
  assert.equal(hasHeartbeatExpired(now - DRIVER_HEARTBEAT_TIMEOUT_MS, now), false);
});

test('a prolonged pause expires the heartbeat after the grace window', () => {
  const now = 1_000_000;
  assert.equal(hasHeartbeatExpired(now - DRIVER_HEARTBEAT_TIMEOUT_MS - 1, now), true);
  assert.equal(hasHeartbeatExpired(0, now), false);
});

test('a new GPS session ignores the previous shift lastUpdate', () => {
  const sessionStartedAt = 2_000_000;
  assert.equal(effectiveDriverHeartbeat({
    lastUpdate: sessionStartedAt - (8 * 60 * 60 * 1000),
    ultima_conexion: sessionStartedAt,
    gpsSessionStartedAt: sessionStartedAt,
  }), sessionStartedAt);
});

test('a fresh GPS point ends the initial session grace period', () => {
  const sessionStartedAt = 2_000_000;
  const lastUpdate = sessionStartedAt + 5_000;
  assert.equal(effectiveDriverHeartbeat({
    lastUpdate,
    gpsSessionStartedAt: sessionStartedAt,
  }), lastUpdate);
});

test('an open shift remains active while connection status is stale', () => {
  assert.equal(isDriverShiftActive({ turno_activo: true, status: null }), true);
  assert.equal(isDriverShiftActive({ turno_activo: false, status: 'online' }), true);
  assert.equal(isDriverShiftActive({ turno_activo: false, status: null }), false);
});
