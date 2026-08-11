import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';

class PresetPlace {
  final String name;
  final String address;
  final double lat;
  final double lng;

  PresetPlace({
    required this.name,
    required this.address,
    required this.lat,
    required this.lng,
  });
}

/// Sedes deportivas y hoteles administrados desde el dashboard
/// (config/sportVenues, config/hotels) -- lectura publica, ver
/// database/firebase-rules.json y dashboard/js/places-admin.js.
class PresetPlacesService {
  static Future<List<PresetPlace>> fetch(String configKey) async {
    final uri = AppConfig.useVpsBackend
        ? Uri.parse('${AppConfig.vpsApiBaseUrl}/api/v1/public/places/$configKey')
        : Uri.parse('${AppConfig.firebaseDbUrl}/config/$configKey.json');
    final response = await http.get(uri).timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw Exception(
        '${AppConfig.useVpsBackend ? 'API VPS' : 'Firebase'} rechazo la consulta (${response.statusCode}): ${response.body}',
      );
    }
    final decoded = jsonDecode(response.body);
    final data = AppConfig.useVpsBackend && decoded is Map
        ? decoded['places']
        : decoded;
    if (data == null) return [];
    final values = AppConfig.useVpsBackend && data is List
        ? data
        : Map<String, dynamic>.from(data).values;
    return values
        .map((v) {
          final place = Map<String, dynamic>.from(v as Map);
          return PresetPlace(
            name: place['name'] as String? ?? '',
            address: place['address'] as String? ?? '',
            lat: (place['lat'] as num).toDouble(),
            lng: (place['lng'] as num).toDouble(),
          );
        })
        .where((p) => p.name.isNotEmpty)
        .toList()
      ..sort((a, b) => a.name.compareTo(b.name));
  }
}
