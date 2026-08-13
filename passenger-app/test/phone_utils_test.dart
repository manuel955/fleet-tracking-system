import 'package:flutter_test/flutter_test.dart';

import 'package:fleet_passenger_app/screens/active_trip_tracking_screen.dart';

void main() {
  test('normaliza el teléfono del conductor para el marcador Android', () {
    expect(normalizePhoneForDialer(' +51 999-123-456 '), '+51999123456');
    expect(normalizePhoneForDialer(51999123456), '51999123456');
    expect(normalizePhoneForDialer(null), '');
  });
}
