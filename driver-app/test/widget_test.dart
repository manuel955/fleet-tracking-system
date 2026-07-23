import 'package:flutter_test/flutter_test.dart';

import 'package:fleet_driver_app/main.dart';

void main() {
  testWidgets('App arranca y muestra la barra de estado', (WidgetTester tester) async {
    await tester.pumpWidget(const FleetDriverApp());
    await tester.pump();

    expect(find.text('Fleet Driver - Solo GPS'), findsOneWidget);
  });
}
