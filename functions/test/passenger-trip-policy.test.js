const test = require('node:test');
const assert = require('node:assert/strict');

const { passengerTripConflict } = require('../passenger-trip-policy');

test('bloquea un segundo viaje inmediato mientras hay uno abierto', () => {
  assert.deepEqual(passengerTripConflict({ active: { status: 'searching' } }, null, 1_000), {
    code: 'ACTIVE_TRIP_EXISTS',
    tripId: 'active',
  });
});

test('permite un viaje inmediato si la reserva está a más de dos horas', () => {
  const trips = { scheduled: { status: 'scheduled', scheduledPickupAt: 10_000_000 } };
  assert.equal(passengerTripConflict(trips, null, 1_000), null);
});

test('bloquea un viaje inmediato cerca de una reserva', () => {
  const trips = { scheduled: { status: 'scheduled', scheduledPickupAt: 2_000 } };
  assert.deepEqual(passengerTripConflict(trips, null, 1_000), {
    code: 'SCHEDULED_TRIP_TOO_CLOSE',
    tripId: 'scheduled',
  });
});

test('solo permite una reserva abierta y no programa durante un viaje activo', () => {
  assert.equal(passengerTripConflict({ done: { status: 'completed' } }, 5_000, 1_000), null);
  assert.equal(passengerTripConflict({ cancelled: { status: 'cancelled' } }, 5_000, 1_000), null);
  assert.equal(passengerTripConflict({ active: { status: 'accepted' } }, 5_000, 1_000)?.code, 'ACTIVE_TRIP_EXISTS');
  assert.equal(passengerTripConflict({ booked: { status: 'scheduled' } }, 5_000, 1_000)?.code, 'SCHEDULED_TRIP_EXISTS');
});
