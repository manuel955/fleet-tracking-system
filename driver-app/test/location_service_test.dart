import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';

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

  Position point({
    required double latitude,
    required double longitude,
    required DateTime timestamp,
    double accuracy = 10,
    double speed = 0,
  }) {
    return Position(
      latitude: latitude,
      longitude: longitude,
      timestamp: timestamp,
      accuracy: accuracy,
      altitude: 0,
      altitudeAccuracy: 0,
      heading: 0,
      headingAccuracy: 0,
      speed: speed,
      speedAccuracy: 0,
    );
  }

  test('descarta deriva pequeña cuando el vehículo está detenido', () {
    final now = DateTime(2026, 8, 10, 22, 0);
    final stable = point(
      latitude: -12.10000,
      longitude: -77.01000,
      timestamp: now,
    );
    final jitter = point(
      latitude: -12.10008,
      longitude: -77.01000,
      timestamp: now.add(const Duration(seconds: 2)),
    );
    expect(
        LocationService.shouldPublishPosition(jitter, stable,
            now: jitter.timestamp),
        isFalse);
  });

  test('descarta un salto de media cuadra con precisión GPS baja', () {
    final now = DateTime(2026, 8, 10, 22, 0);
    final stable = point(
      latitude: -12.10000,
      longitude: -77.01000,
      timestamp: now,
    );
    final drift = point(
      latitude: -12.10040,
      longitude: -77.01000,
      timestamp: now.add(const Duration(seconds: 2)),
    );
    expect(
      LocationService.shouldPublishPosition(drift, stable,
          now: drift.timestamp),
      isFalse,
    );
  });

  test('acepta movimiento real del stream GPS', () {
    final now = DateTime(2026, 8, 10, 22, 0);
    final stable = point(
      latitude: -12.10000,
      longitude: -77.01000,
      timestamp: now,
    );
    final moving = point(
      latitude: -12.10050,
      longitude: -77.01000,
      timestamp: now.add(const Duration(seconds: 2)),
      speed: 8,
    );
    expect(
        LocationService.shouldPublishPosition(moving, stable,
            now: moving.timestamp),
        isTrue);
  });

  test('rechaza una muestra antigua o imprecisa', () {
    final now = DateTime(2026, 8, 10, 22, 0);
    expect(
      LocationService.shouldPublishPosition(
        point(
          latitude: -12.1,
          longitude: -77.01,
          timestamp: now.subtract(const Duration(seconds: 20)),
        ),
        null,
        now: now,
      ),
      isFalse,
    );
    expect(
      LocationService.shouldPublishPosition(
        point(
          latitude: -12.1,
          longitude: -77.01,
          timestamp: now,
          accuracy: 81,
        ),
        null,
        now: now,
      ),
      isFalse,
    );
    expect(
      LocationService.shouldPublishPosition(
        point(
          latitude: -12.1,
          longitude: -77.01,
          timestamp: now,
          accuracy: 45,
        ),
        null,
        now: now,
      ),
      isFalse,
    );
  });
}
