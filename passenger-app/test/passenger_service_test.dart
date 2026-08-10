import 'package:flutter_test/flutter_test.dart';
import 'package:fleet_passenger_app/services/passenger_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('acepta una autorizacion local vigente', () async {
    SharedPreferences.setMockInitialValues({
      'passenger_access_granted': true,
      'passenger_access_legacy': false,
      'passenger_access_expires_at':
          DateTime.now().millisecondsSinceEpoch + 60 * 1000,
    });

    expect(await PassengerService.hasAccess(), isTrue);
  });

  test('elimina una autorizacion local vencida', () async {
    SharedPreferences.setMockInitialValues({
      'passenger_access_granted': true,
      'passenger_access_hotel_name': 'Hotel de prueba',
      'passenger_access_legacy': false,
      'passenger_access_expires_at': DateTime.now().millisecondsSinceEpoch - 1,
    });

    expect(await PassengerService.hasAccess(), isFalse);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.containsKey('passenger_access_granted'), isFalse);
    expect(prefs.containsKey('passenger_access_hotel_name'), isFalse);
    expect(prefs.containsKey('passenger_access_expires_at'), isFalse);
  });

  test('conserva las cuentas heredadas autorizadas por el servidor', () async {
    SharedPreferences.setMockInitialValues({
      'passenger_access_granted': true,
      'passenger_access_legacy': true,
      'passenger_access_expires_at': 0,
    });

    expect(await PassengerService.hasAccess(), isTrue);
  });
}
