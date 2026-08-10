'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPublicationDecision,
  nextBuildNumber,
} = require('../build-policy');

test('reserva un build superior a configuración, reservas y piso de versión', () => {
  assert.equal(
    nextBuildNumber({ configuredBuild: 40, reservedBuild: 0, minimumBuild: 54 }),
    54,
  );
  assert.equal(
    nextBuildNumber({ configuredBuild: 54, reservedBuild: 57, minimumBuild: 54 }),
    58,
  );
});

test('ignora contadores inválidos sin permitir builds menores al piso', () => {
  assert.equal(
    nextBuildNumber({ configuredBuild: 'x', reservedBuild: -8, minimumBuild: 43 }),
    43,
  );
});

test('publicar es monotónico e idempotente', () => {
  assert.deepEqual(buildPublicationDecision(53, 54), {
    ok: true,
    reason: 'publish',
    value: 54,
  });
  assert.deepEqual(buildPublicationDecision(54, 54), {
    ok: true,
    reason: 'already-published',
    value: 54,
  });
  assert.deepEqual(buildPublicationDecision(55, 54), {
    ok: false,
    reason: 'superseded',
    value: 55,
  });
});
