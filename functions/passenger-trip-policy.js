'use strict';

const PASSENGER_TERMINAL_TRIP_STATUSES = new Set(['completed', 'cancelled']);
const PASSENGER_SCHEDULE_MIN_LEAD_MS = 15 * 60 * 1000;
const PASSENGER_SCHEDULE_MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
const PASSENGER_SCHEDULE_GUARD_MS = 2 * 60 * 60 * 1000;

function passengerTripConflict(trips, scheduledPickupAt, now = Date.now()) {
  const openEntries = Object.entries(trips || {}).filter(([, trip]) => (
    trip && !PASSENGER_TERMINAL_TRIP_STATUSES.has(trip.status)
  ));
  const active = openEntries.find(([, trip]) => trip.status !== 'scheduled');
  const scheduled = openEntries.find(([, trip]) => trip.status === 'scheduled');

  if (scheduledPickupAt != null) {
    if (active) return { code: 'ACTIVE_TRIP_EXISTS', tripId: active[0] };
    if (scheduled) return { code: 'SCHEDULED_TRIP_EXISTS', tripId: scheduled[0] };
    return null;
  }
  if (active) return { code: 'ACTIVE_TRIP_EXISTS', tripId: active[0] };
  if (scheduled) {
    const pickupAt = Number(scheduled[1].scheduledPickupAt || 0);
    if (pickupAt > 0 && pickupAt - now <= PASSENGER_SCHEDULE_GUARD_MS) {
      return { code: 'SCHEDULED_TRIP_TOO_CLOSE', tripId: scheduled[0] };
    }
  }
  return null;
}

module.exports = {
  PASSENGER_SCHEDULE_MIN_LEAD_MS,
  PASSENGER_SCHEDULE_MAX_LEAD_MS,
  passengerTripConflict,
};
