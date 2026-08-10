const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTripFeedback } = require('../trip-feedback-policy');

const completedTrip = {
  passengerId: 'passenger-1',
  driverId: 'driver-1',
  status: 'completed',
};

test('acepta una calificacion de un viaje completado', () => {
  const feedback = buildTripFeedback({ tripId: 'trip-1', rating: 5 }, completedTrip, 'passenger-1', 2_000);
  assert.equal(feedback.rating, 5);
  assert.equal(feedback.incidentCategory, 'none');
  assert.equal(feedback.incidentStatus, 'NONE');
  assert.equal(feedback.createdAt, 2_000);
});

test('acepta una incidencia detallada incluso si el viaje fue cancelado', () => {
  const feedback = buildTripFeedback({
    tripId: 'trip-1',
    incidentCategory: 'safety',
    incidentDetails: 'El vehiculo no llego al punto indicado.',
  }, { ...completedTrip, status: 'cancelled' }, 'passenger-1', 2_000);
  assert.equal(feedback.rating, null);
  assert.equal(feedback.incidentCategory, 'safety');
  assert.equal(feedback.incidentStatus, 'OPEN');
});

test('rechaza dueños ajenos, viajes abiertos y datos vacios', () => {
  assert.throws(
    () => buildTripFeedback({ tripId: 'trip-1', rating: 5 }, completedTrip, 'passenger-2'),
    /no encontrado/i,
  );
  assert.throws(
    () => buildTripFeedback({ tripId: 'trip-1', rating: 5 }, { ...completedTrip, status: 'in_progress' }, 'passenger-1'),
    /finalizado/i,
  );
  assert.throws(
    () => buildTripFeedback({ tripId: 'trip-1' }, completedTrip, 'passenger-1'),
    /calificacion, comentario o incidencia/i,
  );
});

test('exige detalle suficiente y solo califica viajes completados', () => {
  assert.throws(
    () => buildTripFeedback({ tripId: 'trip-1', incidentCategory: 'other', incidentDetails: 'Corto' }, completedTrip, 'passenger-1'),
    /10 caracteres/i,
  );
  assert.throws(
    () => buildTripFeedback({ tripId: 'trip-1', rating: 4 }, { ...completedTrip, status: 'cancelled' }, 'passenger-1'),
    /completados/i,
  );
});
