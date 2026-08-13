import test from 'node:test';
import assert from 'node:assert/strict';
import { canUpdateDestination, validateDestinationUpdate } from '../src/app.js';

test('valida un destino completo para cambiarlo durante el viaje', () => {
  assert.deepEqual(validateDestinationUpdate({
    destinationAddress: 'Av. Arequipa 123',
    destinationLat: -12.08,
    destinationLng: -77.04,
  }), {
    destinationAddress: 'Av. Arequipa 123',
    destinationLat: -12.08,
    destinationLng: -77.04,
  });
});

test('rechaza un destino sin coordenadas válidas', () => {
  assert.throws(
    () => validateDestinationUpdate({ destinationAddress: 'Destino', destinationLat: 'x', destinationLng: -77 }),
    /destinationLat/,
  );
});

test('solo permite cambiar destino antes de terminar o cancelar', () => {
  for (const status of ['scheduled', 'searching', 'accepted', 'arrived_at_pickup', 'in_progress']) {
    assert.equal(canUpdateDestination(status), true);
  }
  assert.equal(canUpdateDestination('completed'), false);
  assert.equal(canUpdateDestination('cancelled'), false);
});
