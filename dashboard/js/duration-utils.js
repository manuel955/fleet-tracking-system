(function exposeTripDuration(global) {
  const MAX_REASONABLE_DURATION_MS = 24 * 60 * 60 * 1000;

  function toEpochMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.abs(value) < 1e11 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return Math.abs(numeric) < 1e11 ? numeric * 1000 : numeric;
      }
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function tripDurationMs(trip) {
    const completed = toEpochMs(trip?.completedAt ?? trip?.completed_at);
    const started = toEpochMs(
      trip?.inProgressAt ?? trip?.in_progress_at ??
      trip?.acceptedAt ?? trip?.accepted_at,
    );
    if (completed == null || started == null) return null;
    const duration = completed - started;
    return duration > 0 && duration <= MAX_REASONABLE_DURATION_MS ? duration : null;
  }

  const api = Object.freeze({ toEpochMs, tripDurationMs });
  global.TripDuration = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
