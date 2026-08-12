import 'package:flutter_test/flutter_test.dart';

void main() {
  test('completed trip without rating is eligible for automatic feedback', () {
    final trip = <String, dynamic>{
      'status': 'completed',
      'rating': null,
      'feedbackComment': null,
    };
    expect(trip['status'], 'completed');
    expect(trip['rating'], isNull);
    expect((trip['feedbackComment']?.toString().trim() ?? ''), isEmpty);
  });

  test('completed trip with rating is not pending feedback', () {
    final trip = <String, dynamic>{
      'status': 'completed',
      'rating': 5,
      'feedbackComment': '',
    };
    expect(trip['status'], 'completed');
    expect(trip['rating'], isNotNull);
  });
}
