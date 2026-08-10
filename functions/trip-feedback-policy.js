'use strict';

const INCIDENT_CATEGORIES = new Set([
  'none',
  'driver_conduct',
  'service_quality',
  'safety',
  'lost_item',
  'other',
]);

function buildTripFeedback(input, trip, passengerUid, now = Date.now(), existing = null) {
  if (!trip || trip.passengerId !== passengerUid) {
    throw new Error('Viaje no encontrado.');
  }
  if (!['completed', 'cancelled'].includes(trip.status)) {
    throw new Error('Solo puedes comentar un viaje finalizado o cancelado.');
  }

  const rawRating = input?.rating;
  const rating = rawRating == null || rawRating === '' ? null : Number(rawRating);
  if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new Error('La calificacion debe estar entre 1 y 5.');
  }
  if (trip.status !== 'completed' && rating != null) {
    throw new Error('Solo los viajes completados pueden calificarse.');
  }

  const comment = String(input?.comment || '').trim().slice(0, 500);
  const incidentCategory = String(input?.incidentCategory || 'none').trim();
  const incidentDetails = String(input?.incidentDetails || '').trim().slice(0, 1000);
  if (!INCIDENT_CATEGORIES.has(incidentCategory)) {
    throw new Error('Selecciona un tipo de incidencia valido.');
  }
  if (incidentCategory !== 'none' && incidentDetails.length < 10) {
    throw new Error('Describe la incidencia con al menos 10 caracteres.');
  }
  if (rating == null && incidentCategory === 'none' && !comment) {
    throw new Error('Agrega una calificacion, comentario o incidencia.');
  }
  const sameIncident = existing?.incidentCategory === incidentCategory
    && existing?.incidentDetails === incidentDetails;
  const incidentStatus = incidentCategory === 'none'
    ? 'NONE'
    : (sameIncident && ['OPEN', 'RESOLVED'].includes(existing?.incidentStatus)
      ? existing.incidentStatus
      : 'OPEN');

  return {
    tripId: String(input.tripId),
    passengerId: passengerUid,
    driverId: String(trip.driverId || ''),
    tripStatus: trip.status,
    rating,
    comment,
    incidentCategory,
    incidentDetails,
    incidentStatus,
    createdAt: Number(existing?.createdAt || now),
    updatedAt: now,
    ...(incidentStatus === 'RESOLVED' ? {
      resolvedAt: Number(existing.resolvedAt || now),
      resolvedBy: String(existing.resolvedBy || ''),
    } : {}),
  };
}

module.exports = { INCIDENT_CATEGORIES, buildTripFeedback };
