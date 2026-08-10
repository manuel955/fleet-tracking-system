const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ORPHANED_ASSIGNMENT_TIMEOUT_MS,
  prepareCoordinatorCancellation,
  prepareDashboardCancellation,
  prepareDriverTripTransition,
  shouldReleaseAssignment,
} = require('../trip-lifecycle-policy');

const NOW = 5_000_000;
const DRIVER_ID = 'driver-1';

function baseTrip(overrides = {}) {
  return {
    status: 'accepted',
    driverId: DRIVER_ID,
    passengerId: 'passenger-1',
    pickupLat: -12.0464,
    pickupLng: -77.0428,
    destinationLat: -12.0500,
    destinationLng: -77.0400,
    ...overrides,
  };
}

function transition(trip, newStatus, driver, now) {
  return prepareDriverTripTransition({
    trip,
    driverId: DRIVER_ID,
    newStatus,
    driver,
    now,
  });
}

test('recorre accepted → arrived_at_pickup → in_progress → completed', () => {
  const arrived = transition(
    baseTrip(),
    'arrived_at_pickup',
    { lat: -12.0464, lng: -77.0428 },
    NOW,
  );
  const started = transition(arrived.value, 'in_progress', null, NOW + 1_000);
  const completed = transition(
    started.value,
    'completed',
    { lat: -12.0500, lng: -77.0400 },
    NOW + 2_000,
  );

  assert.equal(arrived.ok, true);
  assert.equal(arrived.value.arrivedAt, NOW);
  assert.equal(started.value.inProgressAt, NOW + 1_000);
  assert.equal(completed.value.status, 'completed');
  assert.equal(completed.value.completedAt, NOW + 2_000);
  assert.equal(completed.value.passengerId, 'passenger-1');
});

test('repetir una transición ya aplicada es idempotente', () => {
  const result = transition(
    baseTrip({ status: 'arrived_at_pickup', arrivedAt: NOW - 1_000 }),
    'arrived_at_pickup',
    { lat: -12.0464, lng: -77.0428 },
    NOW,
  );

  assert.deepEqual(result, {
    ok: true,
    alreadyApplied: true,
    publicStatus: 'arrived_at_pickup',
  });
});

test('rechaza saltos de estado y conductores ajenos', () => {
  const skipped = transition(baseTrip(), 'completed', { lat: -12.05, lng: -77.04 }, NOW);
  const foreign = prepareDriverTripTransition({
    trip: baseTrip(),
    driverId: 'driver-2',
    newStatus: 'arrived_at_pickup',
    driver: { lat: -12.0464, lng: -77.0428 },
    now: NOW,
  });

  assert.equal(skipped.httpStatus, 409);
  assert.equal(skipped.currentStatus, 'accepted');
  assert.equal(foreign.httpStatus, 404);
});

test('rechaza llegada sin GPS o a más de cien metros', () => {
  const missing = transition(baseTrip(), 'arrived_at_pickup', {}, NOW);
  const far = transition(
    baseTrip(),
    'arrived_at_pickup',
    { lat: -12.0600, lng: -77.0600 },
    NOW,
  );

  assert.equal(missing.httpStatus, 422);
  assert.equal(far.httpStatus, 422);
  assert.ok(far.distanceMeters > 100);
});

test('la finalización vuelve a comprobar la cercanía al destino actual', () => {
  const trip = baseTrip({ status: 'in_progress' });
  const far = transition(trip, 'completed', { lat: -12.0464, lng: -77.0428 }, NOW);
  const near = transition(trip, 'completed', { lat: -12.0500, lng: -77.0400 }, NOW);

  assert.equal(far.httpStatus, 422);
  assert.equal(near.ok, true);
  assert.equal(near.value.status, 'completed');
});

test('el coordinador puede cancelar antes del inicio sin perder la asignación', () => {
  const result = prepareCoordinatorCancellation(
    baseTrip({ dispatcherUid: 'coordinator-1' }),
    'coordinator-1',
    NOW,
  );

  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'cancelled');
  assert.equal(result.value.driverId, DRIVER_ID);
  assert.equal(result.value.cancelledBy, 'coordinator');
  assert.equal(result.value.cancelledAt, NOW);
});

test('la cancelación coordinadora rechaza dueño ajeno y estados terminales', () => {
  const foreign = prepareCoordinatorCancellation(
    baseTrip({ dispatcherUid: 'coordinator-1' }),
    'coordinator-2',
    NOW,
  );
  const started = prepareCoordinatorCancellation(
    baseTrip({ status: 'in_progress', dispatcherUid: 'coordinator-1' }),
    'coordinator-1',
    NOW,
  );
  const completed = prepareCoordinatorCancellation(
    baseTrip({ status: 'completed', dispatcherUid: 'coordinator-1' }),
    'coordinator-1',
    NOW,
  );

  assert.equal(foreign.httpStatus, 404);
  assert.equal(started.httpStatus, 409);
  assert.equal(completed.httpStatus, 409);
});

test('el dashboard cancela de forma auditada solo antes de iniciar', () => {
  const result = prepareDashboardCancellation(
    baseTrip(),
    'admin@example.com',
    'Cambio solicitado por operaciones',
    NOW,
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.cancelledBy, 'dashboard');
  assert.equal(result.value.cancelledByUser, 'admin@example.com');
  assert.equal(result.value.cancelledAt, NOW);

  assert.equal(prepareDashboardCancellation(
    baseTrip({ status: 'in_progress' }),
    'admin@example.com',
    'Motivo válido',
    NOW,
  ).ok, false);
  assert.equal(prepareDashboardCancellation(
    baseTrip({ status: 'searching' }),
    'admin@example.com',
    'no',
    NOW,
  ).httpStatus, 400);
});

test('una asignación completada o cancelada queda marcada para liberación', () => {
  const driver = { currentTripId: 'trip-1', assignmentClaimedAt: NOW - 10_000 };

  assert.equal(shouldReleaseAssignment(
    DRIVER_ID,
    driver,
    { driverId: DRIVER_ID, status: 'completed' },
    NOW,
  ), true);
  assert.equal(shouldReleaseAssignment(
    DRIVER_ID,
    driver,
    { driverId: DRIVER_ID, status: 'cancelled' },
    NOW,
  ), true);
});

test('un reclamo huérfano solo se libera después de la ventana de seguridad', () => {
  const staleDriver = {
    currentTripId: 'trip-missing',
    assignmentClaimedAt: NOW - ORPHANED_ASSIGNMENT_TIMEOUT_MS - 1,
  };
  const freshDriver = {
    currentTripId: 'trip-missing',
    assignmentClaimedAt: NOW - ORPHANED_ASSIGNMENT_TIMEOUT_MS,
  };

  assert.equal(shouldReleaseAssignment(DRIVER_ID, staleDriver, null, NOW), true);
  assert.equal(shouldReleaseAssignment(DRIVER_ID, freshDriver, null, NOW), false);
});

test('un viaje activo válido o una nueva asignación nunca se libera', () => {
  const driver = { currentTripId: 'trip-1', assignmentClaimedAt: NOW - 10_000 };
  const active = { driverId: DRIVER_ID, status: 'in_progress' };
  const reassigned = { driverId: 'driver-2', status: 'accepted' };

  assert.equal(shouldReleaseAssignment(DRIVER_ID, driver, active, NOW), false);
  assert.equal(shouldReleaseAssignment(
    DRIVER_ID,
    { ...driver, assignmentClaimedAt: NOW - 1_000 },
    reassigned,
    NOW,
  ), false);
  assert.equal(shouldReleaseAssignment(DRIVER_ID, {}, null, NOW), false);
});
