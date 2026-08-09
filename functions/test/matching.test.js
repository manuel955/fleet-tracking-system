const test = require('node:test');
const assert = require('node:assert/strict');

const {
  claimDriverWithToken,
  rankCandidates,
  rankedCandidatesByRadius,
  releaseDriverWithToken,
  selectCandidate,
  updateTripWhileDispatchableWithToken,
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

function jsonResponse(status, value, etag = 'etag-1') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'etag' ? etag : null },
    json: async () => value,
  };
}

test('no asigna un conductor si el viaje ya fue cancelado', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse(200, { status: 'cancelled' });
  };
  try {
    const updated = await updateTripWhileDispatchableWithToken(
      'trip-cancelled',
      () => ({ status: 'accepted', driverId: 'driver-1' }),
      'test-token',
    );
    assert.equal(updated, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('relee el viaje tras un conflicto y respeta una cancelacion concurrente', async () => {
  const originalFetch = global.fetch;
  const responses = [
    jsonResponse(200, { status: 'searching', passengerId: 'passenger-1' }, 'etag-a'),
    jsonResponse(412, null),
    jsonResponse(200, { status: 'cancelled', passengerId: 'passenger-1' }, 'etag-b'),
  ];
  global.fetch = async () => responses.shift();
  try {
    const updated = await updateTripWhileDispatchableWithToken(
      'trip-race',
      () => ({ status: 'accepted', driverId: 'driver-1' }),
      'test-token',
    );
    assert.equal(updated, false);
    assert.equal(responses.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('confirma la asignacion conservando los datos actuales del viaje', async () => {
  const originalFetch = global.fetch;
  let writtenBody;
  global.fetch = async (_url, options = {}) => {
    if (!options.method) {
      return jsonResponse(200, {
        status: 'scheduled',
        passengerId: 'passenger-1',
        destinationAddress: 'Destino original',
      }, 'etag-a');
    }
    writtenBody = JSON.parse(options.body);
    return jsonResponse(200, null);
  };
  try {
    const updated = await updateTripWhileDispatchableWithToken(
      'trip-scheduled',
      () => ({ status: 'accepted', driverId: 'driver-1' }),
      'test-token',
    );
    assert.equal(updated, true);
    assert.deepEqual(writtenBody, {
      status: 'accepted',
      passengerId: 'passenger-1',
      destinationAddress: 'Destino original',
      driverId: 'driver-1',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('reclama un conductor disponible sin borrar su perfil', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options = {}) => {
    calls.push(options);
    if (!options.method) {
      return jsonResponse(200, {
        status: 'online',
        approvalStatus: 'approved',
        name: 'Conductor Uno',
        lastUpdate: 123,
      }, 'driver-etag');
    }
    return jsonResponse(200, null);
  };
  try {
    const claimed = await claimDriverWithToken('driver-1', 'trip-1', 'token', 999);
    const written = JSON.parse(calls[1].body);

    assert.equal(claimed, true);
    assert.equal(written.status, 'busy');
    assert.equal(written.currentTripId, 'trip-1');
    assert.equal(written.assignmentClaimedAt, 999);
    assert.equal(written.name, 'Conductor Uno');
    assert.equal(written.lastUpdate, 123);
    assert.equal(calls[1].headers['if-match'], 'driver-etag');
  } finally {
    global.fetch = originalFetch;
  }
});

test('no reclama un conductor pendiente u offline', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse(200, { status: 'online', approvalStatus: 'pending' });
  };
  try {
    assert.equal(await claimDriverWithToken('driver-1', 'trip-1', 'token'), false);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('dos reclamos con el mismo ETag dejan ganar solo a uno', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => {
    if (!options.method) {
      return jsonResponse(200, { status: 'online', approvalStatus: 'approved' }, 'shared-etag');
    }
    return jsonResponse(412, null);
  };
  try {
    assert.equal(await claimDriverWithToken('driver-1', 'trip-loser', 'token'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('la liberación relee tras un 412 y conserva el GPS más reciente', async () => {
  const originalFetch = global.fetch;
  let written;
  const responses = [
    jsonResponse(200, {
      status: 'busy', currentTripId: 'trip-1', turno_activo: true, lat: -12.04,
    }, 'etag-a'),
    jsonResponse(412, null),
    jsonResponse(200, {
      status: 'busy', currentTripId: 'trip-1', turno_activo: true, lat: -12.05,
    }, 'etag-b'),
    jsonResponse(200, null),
  ];
  global.fetch = async (_url, options = {}) => {
    const response = responses.shift();
    if (options.method === 'PUT' && response.status === 200) written = JSON.parse(options.body);
    return response;
  };
  try {
    assert.equal(await releaseDriverWithToken('driver-1', 'trip-1', 'token'), true);
    assert.equal(written.status, 'online');
    assert.equal(written.currentTripId, null);
    assert.equal(written.assignmentClaimedAt, null);
    assert.equal(written.lat, -12.05);
    assert.equal(responses.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('la liberación no pisa una asignación de otro viaje', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse(200, {
      status: 'busy', currentTripId: 'trip-2', turno_activo: true,
    });
  };
  try {
    assert.equal(await releaseDriverWithToken('driver-1', 'trip-1', 'token'), false);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('liberar un viaje no reabre un turno que ya terminó', async () => {
  const originalFetch = global.fetch;
  let written;
  global.fetch = async (_url, options = {}) => {
    if (!options.method) {
      return jsonResponse(200, {
        status: 'busy', currentTripId: 'trip-1', turno_activo: false,
      });
    }
    written = JSON.parse(options.body);
    return jsonResponse(200, null);
  };
  try {
    assert.equal(await releaseDriverWithToken('driver-1', 'trip-1', 'token'), true);
    assert.equal(written.status, null);
    assert.equal(written.currentTripId, null);
  } finally {
    global.fetch = originalFetch;
  }
});
