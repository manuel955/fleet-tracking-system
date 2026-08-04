import 'package:flutter_test/flutter_test.dart';

import 'package:fleet_driver_app/services/trip_service.dart';

void main() {
  test('conserva el estado remoto para reconciliar una pantalla atrasada', () {
    const error = TripStateConflictException(
      'El viaje cambio de estado.',
      currentStatus: 'arrived_at_pickup',
    );

    expect(error.currentStatus, 'arrived_at_pickup');
    expect(error.toString(), 'El viaje cambio de estado.');
  });
}
