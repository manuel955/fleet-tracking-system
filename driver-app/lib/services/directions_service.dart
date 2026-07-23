import 'dart:convert';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:http/http.dart' as http;
import '../config.dart';

/// Trae la ruta real entre dos puntos (Routes API) para dibujarla en el
/// mapa del viaje activo. Si la API falla, se usa una linea recta entre los
/// dos puntos como respaldo -- mismo patron que
/// passenger-app/lib/services/directions_service.dart.
class DirectionsService {
  static Future<List<LatLng>> getRoute(LatLng origin, LatLng destination) async {
    final uri = Uri.parse('https://routes.googleapis.com/directions/v2:computeRoutes');
    final response = await http.post(
      uri,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': AppConfig.googleMapsApiKey,
        'X-Goog-FieldMask': 'routes.polyline.encodedPolyline',
      },
      body: jsonEncode({
        'origin': {
          'location': {
            'latLng': {'latitude': origin.latitude, 'longitude': origin.longitude},
          },
        },
        'destination': {
          'location': {
            'latLng': {'latitude': destination.latitude, 'longitude': destination.longitude},
          },
        },
        'travelMode': 'DRIVE',
        'languageCode': 'es',
      }),
    );
    if (response.statusCode != 200) {
      throw Exception('Routes API rechazo la consulta (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
    final routes = data['routes'] as List<dynamic>?;
    if (routes == null || routes.isEmpty) {
      throw Exception('Routes API: sin rutas');
    }
    final points = routes.first['polyline']['encodedPolyline'] as String;
    return _decodePolyline(points);
  }

  static List<LatLng> _decodePolyline(String encoded) {
    final points = <LatLng>[];
    int index = 0, len = encoded.length;
    int lat = 0, lng = 0;

    while (index < len) {
      int b, shift = 0, result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      final dlat = (result & 1) != 0 ? ~(result >> 1) : (result >> 1);
      lat += dlat;

      shift = 0;
      result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      final dlng = (result & 1) != 0 ? ~(result >> 1) : (result >> 1);
      lng += dlng;

      points.add(LatLng(lat / 1e5, lng / 1e5));
    }
    return points;
  }
}
