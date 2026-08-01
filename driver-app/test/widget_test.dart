import 'package:flutter_test/flutter_test.dart';

import 'package:fleet_driver_app/main.dart';

void main() {
  testWidgets('La app del conductor arranca', (WidgetTester tester) async {
    await tester.pumpWidget(const FleetDriverApp());
    await tester.pump();

    expect(find.byType(FleetDriverApp), findsOneWidget);
  });
}
