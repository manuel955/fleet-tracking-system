import 'package:flutter_test/flutter_test.dart';

import 'package:fleet_driver_app/services/notification_service.dart';

void main() {
  test('repite la asignacion cada 10 segundos hasta ser reconocida', () {
    expect(NotificationService.assignedRepeatInterval,
        const Duration(seconds: 10));
    expect(
      NotificationService.shouldRepeatAssigned(
        now: 20000,
        lastShownAt: 10001,
      ),
      false,
    );
    expect(
      NotificationService.shouldRepeatAssigned(
        now: 20001,
        lastShownAt: 10000,
      ),
      true,
    );
  });

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
