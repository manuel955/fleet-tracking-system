import 'package:flutter_test/flutter_test.dart';

import 'package:fleet_passenger_app/main.dart';

void main() {
  testWidgets('La app del pasajero arranca', (WidgetTester tester) async {
    await tester.pumpWidget(const FleetPassengerApp());
    await tester.pump();

    expect(find.byType(FleetPassengerApp), findsOneWidget);
  });
}
