import 'dart:convert';
import 'dart:math';
import 'package:http/http.dart' as http;
import '../config.dart';

class PlaceSuggestion {
  final String description;
  final String placeId;
  PlaceSuggestion({required this.description, required this.placeId});
}

/// Autocompletado de direcciones usando la Places API (New) de Google via
/// HTTP directo (misma key que Maps, sin agregar el SDK nativo de Places).
/// El sessionToken agrupa las llamadas de un mismo buscador (autocomplete +
/// detalle final) en una sola sesion de facturacion, como recomienda Google.
class PlacesService {
  static String newSessionToken() {
    final rand = Random();
    return List.generate(32, (_) => rand.nextInt(16).toRadixString(16)).join();
  }

  static Future<List<PlaceSuggestion>> autocomplete(String input, String sessionToken) async {
    if (input.trim().isEmpty) return [];

    final uri = Uri.parse('https://places.googleapis.com/v1/places:autocomplete');
    final response = await http.post(
      uri,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': AppConfig.googleMapsApiKey,
      },
      body: jsonEncode({
        'input': input,
        'languageCode': 'es',
        'regionCode': 'PE',
        'sessionToken': sessionToken,
      }),
    );

    if (response.statusCode != 200) {
      throw Exception('Places API rechazo la busqueda (${response.statusCode}): ${response.body}');
    }

    final data = jsonDecode(response.body);
    final suggestions = data['suggestions'] as List<dynamic>? ?? [];
    return suggestions
        .map((s) => s['placePrediction'])
        .where((p) => p != null)
        .map((p) => PlaceSuggestion(
              description: p['text']['text'] as String,
              placeId: p['placeId'] as String,
            ))
        .toList();
  }

  static Future<({double lat, double lng})> getPlaceLatLng(String placeId, String sessionToken) async {
    final uri = Uri.parse('https://places.googleapis.com/v1/places/$placeId?sessionToken=$sessionToken');
    final response = await http.get(
      uri,
      headers: {
        'X-Goog-Api-Key': AppConfig.googleMapsApiKey,
        'X-Goog-FieldMask': 'location',
      },
    );

    if (response.statusCode != 200) {
      throw Exception('Places API rechazo el detalle (${response.statusCode}): ${response.body}');
    }

    final data = jsonDecode(response.body);
    final location = data['location'];
    return (lat: (location['latitude'] as num).toDouble(), lng: (location['longitude'] as num).toDouble());
  }

  /// Geocodificacion inversa: convierte un punto (lat/lng) elegido a mano
  /// en el mapa en una direccion legible, para rellenar el buscador cuando
  /// el pasajero arrastra el pin en vez de escribir.
  static Future<String> reverseGeocode(double lat, double lng) async {
    final uri = Uri.parse(
      'https://maps.googleapis.com/maps/api/geocode/json'
      '?latlng=$lat,$lng&language=es&key=${AppConfig.googleMapsApiKey}',
    );
    final response = await http.get(uri);
    if (response.statusCode != 200) {
      throw Exception('Geocoding API rechazo la consulta (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
    if (data['status'] != 'OK') {
      throw Exception('Geocoding API: ${data['status']}');
    }
    final results = data['results'] as List<dynamic>;
    if (results.isEmpty) throw Exception('Sin resultados');
    return results.first['formatted_address'] as String;
  }
}
