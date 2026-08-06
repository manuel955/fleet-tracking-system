import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';
import 'map_adapter.dart';

/// Adapter de Mapbox Directions. Conserva la interfaz que ya usan las
/// pantallas y devuelve una ruta segura para que la UI pueda aplicar su
/// fallback de linea recta cuando no hay red o token.
class DirectionsService {
  static Future<List<LatLng>> getRoute(
    LatLng origin,
    LatLng destination,
  ) async {
    final token = AppConfig.mapboxAccessToken;
    if (token.isEmpty) throw Exception('MAPBOX_ACCESS_TOKEN no configurado');

    final coordinates =
        '${origin.longitude},${origin.latitude};'
        '${destination.longitude},${destination.latitude}';
    final uri = Uri.https(
      'api.mapbox.com',
      '/directions/v5/mapbox/driving/$coordinates',
      <String, String>{
        'access_token': token,
        'geometries': 'geojson',
        'overview': 'full',
        'steps': 'true',
        'language': 'es',
      },
    );
    final response = await http.get(uri).timeout(const Duration(seconds: 12));
    if (response.statusCode != 200) {
      throw Exception('Mapbox Directions rechazo la consulta (${response.statusCode})');
    }
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    final routes = data['routes'] as List<dynamic>?;
    if (routes == null || routes.isEmpty) {
      throw Exception('Mapbox Directions: sin rutas');
    }
    final geometry = routes.first['geometry'] as Map<String, dynamic>?;
    final rawCoordinates = geometry?['coordinates'] as List<dynamic>?;
    if (rawCoordinates == null || rawCoordinates.length < 2) {
      throw Exception('Mapbox Directions: geometria vacia');
    }
    return rawCoordinates
        .whereType<List<dynamic>>()
        .where((point) => point.length >= 2)
        .map((point) => LatLng(
              (point[1] as num).toDouble(),
              (point[0] as num).toDouble(),
            ))
        .toList();
  }
}
