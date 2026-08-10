import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:fleet_passenger_app/main.dart';
import 'package:fleet_passenger_app/screens/email_link_screen.dart';
import 'package:fleet_passenger_app/services/places_service.dart';

void main() {
  testWidgets('La app del pasajero arranca', (WidgetTester tester) async {
    await tester.pumpWidget(const FleetPassengerApp());
    await tester.pump();

    expect(find.byType(FleetPassengerApp), findsOneWidget);
  });

  testWidgets('La recuperación de cuenta usa correo y no SMS', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(home: EmailLinkScreen(onAuthenticated: (_) async {})),
    );

    expect(find.text('Vincula un correo'), findsOneWidget);
    expect(find.text('Correo electrónico'), findsOneWidget);
    expect(find.textContaining('sin códigos SMS'), findsOneWidget);
    expect(find.text('Enviar código SMS'), findsNothing);
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
