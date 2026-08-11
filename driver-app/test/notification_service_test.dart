import 'package:flutter_test/flutter_test.dart';

import 'package:fleet_driver_app/services/notification_service.dart';

void main() {
  test('la voz dice Hoy a las para una fecha del mismo día', () {
    final now = DateTime(2026, 8, 10, 22);
    expect(
      NotificationService.scheduledPickupText('10/08, 10:39 p. m.', now: now),
      'Hoy a las 10:39 p. m.',
    );
  });

  test('conserva la fecha para un viaje de otro día', () {
    final now = DateTime(2026, 8, 10, 22);
    expect(
      NotificationService.scheduledPickupText('11/08, 10:39 p. m.', now: now),
      '11/08, 10:39 p. m.',
    );
  });
}
