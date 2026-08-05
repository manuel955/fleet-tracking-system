import 'map_adapter.dart';

/// Representacion estable del conductor. Mapbox mantiene la anotacion y solo
/// actualiza su geometria cuando llega una nueva posicion.
class CarIcon {
  static BitmapDescriptor? _cached;

  static Future<BitmapDescriptor> build() async {
    return _cached ??= BitmapDescriptor.defaultMarkerWithHue(
      BitmapDescriptor.hueBlue,
    );
  }
}
