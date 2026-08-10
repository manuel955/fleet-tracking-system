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
    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/config/$configKey.json');
    final response = await http.get(uri).timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw Exception(
        'Firebase rechazo la consulta (${response.statusCode}): ${response.body}',
      );
    }
    final data = jsonDecode(response.body);
    if (data == null) return [];
    final map = Map<String, dynamic>.from(data);
    return map.values
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
