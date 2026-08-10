import 'package:flutter_test/flutter_test.dart';
import 'package:fleet_passenger_app/services/trip_service.dart';

void main() {
  test('solo acepta una ubicación de conductor reciente', () {
    final now = DateTime.fromMillisecondsSinceEpoch(100000);

    expect(
      TripService.hasFreshDriverLocation({'lastUpdate': 71000}, now: now),
      isTrue,
    );
    expect(
      TripService.hasFreshDriverLocation({'lastUpdate': 69000}, now: now),
      isFalse,
    );
    expect(
      TripService.hasFreshDriverLocation(<String, dynamic>{}, now: now),
      isFalse,
    );
  });
}
