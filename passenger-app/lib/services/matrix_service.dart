import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';
import 'map_adapter.dart';

class MatrixResult {
  final List<List<double?>> durationsSeconds;
  final List<List<double?>> distancesMeters;

  const MatrixResult({
    required this.durationsSeconds,
    required this.distancesMeters,
  });
}

/// Adaptador de ETA/distancia por lote para Mapbox Matrix. No altera el
/// matching del backend ni la forma en que se reciben coordenadas.
class MatrixService {
  static Future<MatrixResult> getMatrix(
    List<LatLng> points, {
    List<int>? sources,
    List<int>? destinations,
  }) async {
    if (points.length < 2) {
      return const MatrixResult(durationsSeconds: [], distancesMeters: []);
    }
    if (points.length > 10) {
      throw Exception('Mapbox Matrix admite maximo 10 coordenadas');
    }
    final token = AppConfig.mapboxAccessToken;
    if (token.isEmpty) throw Exception('MAPBOX_ACCESS_TOKEN no configurado');
    final coordinates = points
        .map((point) => '${point.longitude},${point.latitude}')
        .join(';');
    final uri = Uri.https(
      'api.mapbox.com',
      '/directions-matrix/v1/mapbox/driving/$coordinates',
      <String, String>{
        'access_token': token,
        'annotations': 'duration,distance',
        if (sources != null) 'sources': sources.join(';'),
        if (destinations != null) 'destinations': destinations.join(';'),
      },
    );
    final response = await http.get(uri).timeout(const Duration(seconds: 12));
    if (response.statusCode != 200) {
      throw Exception('Mapbox Matrix rechazo la consulta (${response.statusCode})');
    }
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    List<List<double?>> matrix(String key) => (data[key] as List<dynamic>? ?? [])
        .map((row) => (row as List<dynamic>)
            .map((value) => value is num ? value.toDouble() : null)
            .toList())
        .toList();
    return MatrixResult(
      durationsSeconds: matrix('durations'),
      distancesMeters: matrix('distances'),
    );
  }
}
