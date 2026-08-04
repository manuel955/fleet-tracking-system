import 'package:flutter_test/flutter_test.dart';

import 'package:fleet_driver_app/services/location_service.dart';

void main() {
  test('acepta coordenadas GPS reales', () {
    expect(LocationService.isUsableCoordinates(-12.0464, -77.0428), isTrue);
  });

  test('rechaza coordenadas vacias o fuera de rango', () {
    expect(LocationService.isUsableCoordinates(0, 0), isFalse);
    expect(LocationService.isUsableCoordinates(91, -77), isFalse);
    expect(LocationService.isUsableCoordinates(-12, 181), isFalse);
  });
}
