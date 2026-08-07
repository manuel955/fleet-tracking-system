const test = require('node:test');
const assert = require('node:assert/strict');
const { notificationData } = require('../notifications');

test('FCM notification data is string-safe for driver alerts', () => {
  assert.deepEqual(
    notificationData('trip_cancelled', {
      tripId: 'trip-1',
      reason: 'El pasajero canceló',
      empty: null,
    }),
    {
      type: 'trip_cancelled',
      tripId: 'trip-1',
      reason: 'El pasajero canceló',
      empty: '',
    },
  );
});
