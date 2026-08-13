const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessions, isQaRecord } = require('../js/attendance-utils.js');

test('ignora registros QA en asistencia', () => {
  assert.equal(isQaRecord('qa_1785713032480_auto', 'QA Auto'), true);
  assert.equal(isQaRecord('driver-real', 'Ever Lozada Cordova'), false);
  assert.equal(buildSessions({ qa_1: { a: { status: 'online', at: 100 } } }, {}).length, 0);
});

test('consolida heartbeats online repetidos en un solo turno', () => {
  const sessions = buildSessions({
    driver1: {
      first: { status: 'online', at: 100, driverName: 'Ever' },
      heartbeat: { status: 'online', at: 105, driverName: 'Ever' },
      offline: { status: 'offline', at: 220, driverName: 'Ever' },
    },
  }, { driver1: { name: 'Ever', status: 'offline' } });
  assert.deepEqual(sessions, [{
    driverId: 'driver1', driverName: 'Ever', startAt: 100, endAt: 220, active: false,
  }]);
});

test('cierra un turno sin evento offline usando el último GPS', () => {
  const sessions = buildSessions({
    driver1: { online: { status: 'online', at: 100 } },
  }, { driver1: { name: 'Ever', status: 'offline', lastUpdate: 180 } });
  assert.equal(sessions[0].endAt, 180);
  assert.equal(sessions[0].active, false);
});

test('un conductor VPS actualmente online conserva un turno aunque falte el evento de inicio', () => {
  const sessions = buildSessions({}, {
    'driver-1': { name: 'Irma ballardo', status: 'online', shiftStartedAt: 1_000, lastUpdate: 2_000 },
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].active, true);
  assert.equal(sessions[0].startAt, 1_000);
});
