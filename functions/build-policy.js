'use strict';

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function nextBuildNumber({ configuredBuild, reservedBuild, minimumBuild }) {
  const configured = positiveInteger(configuredBuild);
  const reserved = positiveInteger(reservedBuild);
  const minimum = positiveInteger(minimumBuild);
  return Math.max(configured + 1, reserved + 1, minimum);
}

function buildPublicationDecision(currentBuild, requestedBuild) {
  const current = positiveInteger(currentBuild);
  const requested = positiveInteger(requestedBuild);
  if (!requested) {
    return { ok: false, reason: 'invalid', value: current };
  }
  if (requested < current) {
    return { ok: false, reason: 'superseded', value: current };
  }
  return {
    ok: true,
    reason: requested === current ? 'already-published' : 'publish',
    value: Math.max(current, requested),
  };
}

module.exports = { buildPublicationDecision, nextBuildNumber, positiveInteger };
