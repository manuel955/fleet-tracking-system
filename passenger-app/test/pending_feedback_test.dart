import 'package:flutter_test/flutter_test.dart';
import 'package:fleet_passenger_app/services/trip_service.dart';

void main() {
  test('completed trip without rating is eligible for automatic feedback', () {
    final trip = <String, dynamic>{
      'status': 'completed',
      'rating': null,
      'feedbackComment': null,
    };
    expect(TripService.needsFeedback(trip), isTrue);
  });

  test('completed trip with rating is not pending feedback', () {
    final trip = <String, dynamic>{
      'status': 'completed',
      'rating': 5,
      'feedbackComment': '',
    };
    expect(TripService.needsFeedback(trip), isFalse);
  });

  test('nested incident is treated as submitted feedback', () {
    final trip = <String, dynamic>{
      'status': 'completed',
      'feedback': <String, dynamic>{
        'rating': null,
        'comment': '',
        'incidentCategory': 'lost_item',
        'incidentDetails': 'Olvide una mochila en el vehiculo.',
      },
    };
    expect(TripService.needsFeedback(trip), isFalse);
  });
}
