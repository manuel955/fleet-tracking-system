import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDriverPlaceInput } from '../src/app.js';

test('normaliza los tipos de lugar que envía el dashboard', () => {
  assert.deepEqual(normalizeDriverPlaceInput({ type: 'hotel', name: 'Hotel A' }), {
    type: 'hotel',
    name: 'Hotel A',
  });
  assert.deepEqual(normalizeDriverPlaceInput({ type: 'sportVenues', name: 'VIDENA' }), {
    type: 'sportVenue',
    name: 'VIDENA',
  });
});

test('rechaza un tipo de lugar desconocido', () => {
  assert.throws(
    () => normalizeDriverPlaceInput({ type: 'airport', name: 'A' }),
    /Tipo de lugar/,
  );
});
