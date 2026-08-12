const test = require('node:test');
const assert = require('node:assert/strict');
const { tripDurationMs } = require('../js/duration-utils.js');

test('calcula duración con marcas ISO y descarta un viaje sin inicio', () => {
  assert.equal(
    tripDurationMs({
      acceptedAt: '2026-08-11T20:00:00.000Z',
      completedAt: '2026-08-11T20:12:30.000Z',
    }),
    12.5 * 60 * 1000,
  );
  assert.equal(tripDurationMs({ completedAt: Date.now() }), null);
});

test('acepta epochs en segundos y descarta duraciones imposibles', () => {
  assert.equal(tripDurationMs({ acceptedAt: 1000, completedAt: 1060 }), 60_000);
  assert.equal(tripDurationMs({ acceptedAt: 0, completedAt: Date.now() }), null);
  assert.equal(
    tripDurationMs({ acceptedAt: 1, completedAt: 3 * 24 * 60 * 60 * 1000 }),
    null,
  );
});
