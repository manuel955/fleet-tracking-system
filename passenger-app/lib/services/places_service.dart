import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import '../config.dart';

class PlaceSuggestion {
  final String description;
  final String placeId;
  final double? lat;
  final double? lng;

  PlaceSuggestion({
    required this.description,
    required this.placeId,
    this.lat,
    this.lng,
  });
}

/// Adaptador de busqueda/geocodificacion de Mapbox. Se conserva la interfaz
/// usada por las pantallas para no cambiar la navegacion ni el estado de los
/// viajes.
class PlacesService {
  static final Map<String, ({double lat, double lng})> _coordinatesById = {};
  static final Map<String, ({DateTime expiresAt, List<PlaceSuggestion> results})>
      _autocompleteCache = {};
  static final Map<String, ({DateTime expiresAt, String address})>
      _reverseGeocodeCache = {};

  static String newSessionToken() {
    final rand = Random();
    return List.generate(32, (_) => rand.nextInt(16).toRadixString(16)).join();
  }

  static Future<List<PlaceSuggestion>> autocomplete(
    String input,
    String sessionToken,
  ) async {
    final query = input.trim();
    if (query.length < 3) return [];
    final token = AppConfig.mapboxAccessToken;
    if (token.isEmpty) throw Exception('MAPBOX_ACCESS_TOKEN no configurado');
    final cacheKey = query.toLowerCase();
    final cached = _autocompleteCache[cacheKey];
    if (cached != null && cached.expiresAt.isAfter(DateTime.now())) {
      return cached.results;
    }

    final uri = Uri.https(
      'api.mapbox.com',
      '/search/geocode/v6/forward',
      <String, String>{
        'q': query,
        'autocomplete': 'true',
        'limit': '3',
        'language': 'es',
        'country': 'pe',
        'permanent': 'false',
        'access_token': token,
      },
    );
    final response = await http.get(uri).timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw Exception('Mapbox Geocoding rechazo la busqueda (${response.statusCode})');
    }
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    final features = data['features'] as List<dynamic>? ?? [];
    final results = features.whereType<Map<String, dynamic>>().map((feature) {
      final properties = feature['properties'] as Map<String, dynamic>? ?? {};
      final geometry = feature['geometry'] as Map<String, dynamic>? ?? {};
      final coordinates = geometry['coordinates'] as List<dynamic>? ?? [];
      final id = (feature['id'] ?? properties['mapbox_id'] ?? '').toString();
      final lng = coordinates.isNotEmpty ? (coordinates[0] as num).toDouble() : null;
      final lat = coordinates.length > 1 ? (coordinates[1] as num).toDouble() : null;
      if (lat != null && lng != null && id.isNotEmpty) {
        _coordinatesById[id] = (lat: lat, lng: lng);
      }
      final description = (properties['full_address'] ??
              properties['name'] ??
              feature['place_name'] ??
              query)
          .toString();
      return PlaceSuggestion(
        description: description,
        placeId: id,
        lat: lat,
        lng: lng,
      );
    }).toList();
    _autocompleteCache[cacheKey] = (
      expiresAt: DateTime.now().add(const Duration(minutes: 5)),
      results: results,
    );
    return results;
  }

  static Future<({double lat, double lng})> getPlaceLatLng(
    String placeId,
    String sessionToken,
  ) async {
    final cached = _coordinatesById[placeId];
    if (cached != null) return cached;
    throw Exception('La sugerencia de Mapbox ya no esta disponible');
  }

  static Future<String> reverseGeocode(double lat, double lng) async {
    final cacheKey = '${lat.toStringAsFixed(4)},${lng.toStringAsFixed(4)}';
    final cached = _reverseGeocodeCache[cacheKey];
    if (cached != null && cached.expiresAt.isAfter(DateTime.now())) {
      return cached.address;
    }
    final token = AppConfig.mapboxAccessToken;
    if (token.isEmpty) throw Exception('MAPBOX_ACCESS_TOKEN no configurado');
    final uri = Uri.https(
      'api.mapbox.com',
      '/search/geocode/v6/reverse',
      <String, String>{
        'longitude': '$lng',
        'latitude': '$lat',
        'language': 'es',
        'country': 'pe',
        'permanent': 'false',
        'access_token': token,
      },
    );
    final response = await http.get(uri).timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw Exception('Mapbox Geocoding rechazo la consulta (${response.statusCode})');
    }
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    final features = data['features'] as List<dynamic>? ?? [];
    if (features.isEmpty) throw Exception('Sin resultados');
    final first = features.first as Map<String, dynamic>;
    final properties = first['properties'] as Map<String, dynamic>? ?? {};
    final address =
        (properties['full_address'] ?? properties['name'] ?? 'Ubicacion seleccionada')
            .toString();
    _reverseGeocodeCache[cacheKey] = (
      expiresAt: DateTime.now().add(const Duration(minutes: 10)),
      address: address,
    );
    return address;
  }
}
