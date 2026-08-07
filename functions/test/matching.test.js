const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rankCandidates,
  rankedCandidatesByRadius,
  selectCandidate,
} = require('../matching');

function candidate(id, categoryIndex, dist) {
  return { id, categoryIndex, dist };
}

test('prioriza Auto para viajes de hasta cuatro pasajeros aunque este mas lejos', () => {
  const selected = selectCandidate([
    candidate('suv-cercano', 1, 0.4),
    candidate('auto-lejano', 0, 8.2),
    candidate('auto-cercano', 0, 2.1),
  ], 1);

  assert.equal(selected.id, 'auto-cercano');
  assert.deepEqual(
    rankCandidates([
      candidate('suv-cercano', 1, 0.4),
      candidate('auto-lejano', 0, 8.2),
      candidate('auto-cercano', 0, 2.1),
    ], 1).map((item) => item.id),
    ['auto-cercano', 'auto-lejano', 'suv-cercano'],
  );
});

test('sube a SUV y luego a Mini van solo cuando no queda categoria menor', () => {
  const ranked = rankCandidates([
    candidate('mini-van', 2, 0.2),
    candidate('suv-lejano', 1, 6),
    candidate('suv-cercano', 1, 2),
  ], 1);

  assert.deepEqual(ranked.map((item) => item.id), [
    'suv-cercano',
    'suv-lejano',
    'mini-van',
  ]);
});

test('para cinco pasajeros la categoria minima es SUV', () => {
  const selected = selectCandidate([
    candidate('auto', 0, 0.1),
    candidate('mini-van', 2, 0.2),
    candidate('suv', 1, 9),
  ], 5);

  assert.equal(selected.id, 'suv');
});

test('busca primero hasta 2 km y solo amplia a 4 km si el primer rango esta vacio', () => {
  const [near, expanded] = rankedCandidatesByRadius([
    candidate('suv-a-1km', 1, 1),
    candidate('auto-a-3km', 0, 3),
    candidate('auto-a-5km', 0, 5),
  ], 1);

  assert.deepEqual(near.map((item) => item.id), ['suv-a-1km']);
  assert.deepEqual(expanded.map((item) => item.id), ['auto-a-3km', 'suv-a-1km']);
});

test('a 4 km conserva la prioridad de categoria y excluye vehiculos fuera del rango', () => {
  const [near, expanded] = rankedCandidatesByRadius([
    candidate('auto-a-4km', 0, 4),
    candidate('suv-a-2km', 1, 2),
    candidate('auto-fuera', 0, 4.01),
  ], 1);

  assert.deepEqual(near.map((item) => item.id), ['suv-a-2km']);
  assert.deepEqual(expanded.map((item) => item.id), ['auto-a-4km', 'suv-a-2km']);
});
