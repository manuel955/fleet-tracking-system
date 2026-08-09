import 'package:flutter_test/flutter_test.dart';

import 'package:fleet_passenger_app/main.dart';
import 'package:fleet_passenger_app/services/places_service.dart';

void main() {
  testWidgets('La app del pasajero arranca', (WidgetTester tester) async {
    await tester.pumpWidget(const FleetPassengerApp());
    await tester.pump();

    expect(find.byType(FleetPassengerApp), findsOneWidget);
  });

  test('VIDENA y sus puertas aparecen como destinos locales', () async {
    final videna = await PlacesService.autocomplete('videna', 'test');
    final puerta4 = await PlacesService.autocomplete('videna puerta 4', 'test');

    expect(
      videna.any(
        (place) => place.description.contains('Villa Deportiva Nacional'),
      ),
      isTrue,
    );
    expect(puerta4, hasLength(1));
    expect(puerta4.single.description, contains('Puerta 4'));
    expect(puerta4.single.description, contains('San Luis'));
  });
}
