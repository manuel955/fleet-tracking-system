const EXPECTED_STATUS_BY_NEXT = {
  arrived_at_pickup: 'accepted',
  in_progress: 'arrived_at_pickup',
  completed: 'in_progress',
};

const TIMESTAMP_FIELD_BY_STATUS = {
  arrived_at_pickup: 'arrivedAt',
  in_progress: 'inProgressAt',
  completed: 'completedAt',
};

const CLOSED_TRIP_STATUSES = new Set(['completed', 'cancelled']);
const DRIVER_ARRIVAL_RADIUS_METERS = 100;
const ORPHANED_ASSIGNMENT_TIMEOUT_MS = 2 * 60 * 1000;

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRadians = (value) => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2))
    * Math.sin(dLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function policyError(httpStatus, error, extra = {}) {
  return { ok: false, httpStatus, error, ...extra };
}

function prepareDriverTripTransition({
  trip,
  driverId,
  newStatus,
  driver,
  now,
  arrivalRadiusMeters = DRIVER_ARRIVAL_RADIUS_METERS,
}) {
  const expectedStatus = EXPECTED_STATUS_BY_NEXT[newStatus];
  if (!expectedStatus) return policyError(400, 'Transición de viaje inválida.');
  if (!trip || trip.driverId !== driverId) {
    return policyError(404, 'Viaje no encontrado.');
  }
  if (trip.status === newStatus) {
    return { ok: true, alreadyApplied: true, publicStatus: newStatus };
  }
  if (trip.status !== expectedStatus) {
    return policyError(
      409,
      'El viaje cambió de estado. Actualiza la pantalla.',
      { currentStatus: trip.status || null },
    );
  }

  if (newStatus === 'arrived_at_pickup' || newStatus === 'completed') {
    const lat = Number(driver?.lat);
    const lng = Number(driver?.lng);
    const targetLat = Number(newStatus === 'completed' ? trip.destinationLat : trip.pickupLat);
    const targetLng = Number(newStatus === 'completed' ? trip.destinationLng : trip.pickupLng);
    if (![lat, lng, targetLat, targetLng].every(Number.isFinite)) {
      return policyError(422, 'Aún no recibimos una posición GPS válida. Espera unos segundos.');
    }
    const distance = distanceMeters(lat, lng, targetLat, targetLng);
    if (distance > arrivalRadiusMeters) {
      return policyError(
        422,
        `Debes estar a menos de ${arrivalRadiusMeters} metros del punto. Distancia actual: ${Math.round(distance)} m.`,
        { distanceMeters: Math.round(distance) },
      );
    }
  }

  return {
    ok: true,
    publicStatus: newStatus,
    value: {
      ...trip,
      status: newStatus,
      [TIMESTAMP_FIELD_BY_STATUS[newStatus]]: now,
    },
  };
}

function prepareCoordinatorCancellation(trip, coordinatorUid, now) {
  if (!trip || trip.dispatcherUid !== coordinatorUid) {
    return policyError(404, 'Viaje no encontrado');
  }
  if (['in_progress', 'completed', 'cancelled'].includes(trip.status)) {
    return policyError(409, 'Este viaje ya inició o terminó y no puede cancelarse.');
  }
  return {
    ok: true,
    value: {
      ...trip,
      status: 'cancelled',
      cancelledBy: 'coordinator',
      cancelReason: 'Cancelado por el coordinador de la sede.',
      cancelledAt: now,
    },
  };
}

function shouldReleaseAssignment(driverId, driver, trip, now) {
  const tripId = driver?.currentTripId;
  if (!tripId) return false;
  const closedAssignment = trip?.driverId === driverId
    && CLOSED_TRIP_STATUSES.has(trip.status);
  const claimedAt = Number(driver?.assignmentClaimedAt || 0);
  const orphanedClaim = claimedAt > 0
    && now - claimedAt > ORPHANED_ASSIGNMENT_TIMEOUT_MS
    && (!trip || trip.driverId !== driverId);
  return closedAssignment || orphanedClaim;
}

module.exports = {
  DRIVER_ARRIVAL_RADIUS_METERS,
  EXPECTED_STATUS_BY_NEXT,
  ORPHANED_ASSIGNMENT_TIMEOUT_MS,
  distanceMeters,
  prepareCoordinatorCancellation,
  prepareDriverTripTransition,
  shouldReleaseAssignment,
};
