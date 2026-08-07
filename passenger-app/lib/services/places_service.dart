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

class _KnownPlace {
  final String id;
  final String label;
  final double lat;
  final double lng;

  const _KnownPlace({
    required this.id,
    required this.label,
    required this.lat,
    required this.lng,
  });
}

/// Adaptador de busqueda/geocodificacion de Mapbox. Se conserva la interfaz
/// usada por las pantallas para no cambiar la navegacion ni el estado de los
/// viajes.
class PlacesService {
  static final Map<String, ({double lat, double lng})> _coordinatesById = {};
  static final Map<
    String,
    ({DateTime expiresAt, List<PlaceSuggestion> results})
  >
  _autocompleteCache = {};
  static final Map<String, ({DateTime expiresAt, String address})>
  _reverseGeocodeCache = {};

  // Mapbox no siempre indexa los complejos deportivos y sus accesos como POI.
  // Estas entradas evitan que "videna" termine convertido en "Viena" o
  // "Wide" y permiten escoger directamente una puerta de ingreso.
  static const _knownVidenaPlaces = <_KnownPlace>[
    _KnownPlace(
      id: 'known-videna',
      label: 'Villa Deportiva Nacional (VIDENA) · San Luis, Lima',
      lat: -12.0806801,
      lng: -77.0030403,
    ),
    _KnownPlace(
      id: 'known-videna-puerta-1',
      label: 'VIDENA · Puerta 1 · Av. del Aire cdra. 8 s/n, San Luis, Lima',
      lat: -12.0806801,
      lng: -77.0030403,
    ),
    _KnownPlace(
      id: 'known-videna-puerta-2',
      label: 'VIDENA · Puerta 2 · Av. del Aire, San Luis, Lima',
      lat: -12.0800089,
      lng: -77.0014494,
    ),
    _KnownPlace(
      id: 'known-videna-puerta-4',
      label: 'VIDENA · Puerta 4 · Av. del Aire s/n, San Luis, Lima',
      lat: -12.0811262,
      lng: -77.0030219,
    ),
    _KnownPlace(
      id: 'known-videna-puerta-6',
      label: 'VIDENA · Puerta 6 · Av. San Luis 1180, San Luis, Lima',
      lat: -12.0789240,
      lng: -76.9988799,
    ),
    _KnownPlace(
      id: 'known-videna-puerta-7',
      label: 'VIDENA · Puerta 7 · Av. San Luis, San Luis, Lima',
      lat: -12.0800930,
      lng: -76.9983900,
    ),
    _KnownPlace(
      id: 'known-videna-puerta-12',
      label: 'VIDENA · Puerta 12 · Av. Canadá, San Luis, Lima',
      lat: -12.0832330,
      lng: -76.9998650,
    ),
    _KnownPlace(
      id: 'known-videna-puerta-13',
      label: 'VIDENA · Puerta 13 · Av. Aviación, San Luis, Lima',
      lat: -12.0824257,
      lng: -77.0040621,
    ),
    _KnownPlace(
      id: 'known-videna-puerta-14',
      label: 'VIDENA · Puerta 14 · Av. Aviación, San Luis, Lima',
      lat: -12.0818306,
      lng: -77.0045532,
    ),
  ];

  static String newSessionToken() {
    final rand = Random();
    return List.generate(32, (_) => rand.nextInt(16).toRadixString(16)).join();
  }

  static String _normalize(String value) {
    return value
        .toLowerCase()
        .replaceAll('á', 'a')
        .replaceAll('é', 'e')
        .replaceAll('í', 'i')
        .replaceAll('ó', 'o')
        .replaceAll('ú', 'u')
        .replaceAll('ü', 'u')
        .replaceAll('ñ', 'n')
        .replaceAll(RegExp(r'[^a-z0-9]+'), ' ')
        .trim();
  }

  static List<PlaceSuggestion> _knownMatches(String input) {
    final query = _normalize(input);
    final isVidena =
        query.contains('videna') || query.contains('villa deportiva nacional');
    if (!isVidena) return [];

    final gateMatch = RegExp(r'puerta\s*(\d{1,2})').firstMatch(query);
    List<_KnownPlace> matches;
    if (gateMatch != null) {
      final gate = gateMatch.group(1)!;
      matches = _knownVidenaPlaces
          .where((place) => place.id.endsWith('-puerta-$gate'))
          .toList();
      if (matches.isEmpty) {
        matches = [
          _KnownPlace(
            id: 'known-videna-puerta-$gate',
            label: 'VIDENA · Puerta $gate · San Luis, Lima',
            lat: -12.0806801,
            lng: -77.0030403,
          ),
        ];
      }
    } else {
      matches = _knownVidenaPlaces.toList();
    }

    return matches
        .map((place) {
          final coordinates = (lat: place.lat, lng: place.lng);
          _coordinatesById[place.id] = coordinates;
          return PlaceSuggestion(
            description: place.label,
            placeId: place.id,
            lat: place.lat,
            lng: place.lng,
          );
        })
        .take(8)
        .toList();
  }

  static Future<List<PlaceSuggestion>> autocomplete(
    String input,
    String sessionToken,
  ) async {
    final query = input.trim();
    if (query.length < 3) return [];
    final knownResults = _knownMatches(query);
    if (knownResults.isNotEmpty) {
      _autocompleteCache[query.toLowerCase()] = (
        expiresAt: DateTime.now().add(const Duration(minutes: 30)),
        results: knownResults,
      );
      return knownResults;
    }
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
        'limit': '8',
        'language': 'es',
        'country': 'pe',
        'permanent': 'false',
        'access_token': token,
      },
    );
    final response = await http.get(uri).timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw Exception(
        'Mapbox Geocoding rechazo la busqueda (${response.statusCode})',
      );
    }
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    final features = data['features'] as List<dynamic>? ?? [];
    final results = features.whereType<Map<String, dynamic>>().map((feature) {
      final properties = feature['properties'] as Map<String, dynamic>? ?? {};
      final geometry = feature['geometry'] as Map<String, dynamic>? ?? {};
      final coordinates = geometry['coordinates'] as List<dynamic>? ?? [];
      final id = (feature['id'] ?? properties['mapbox_id'] ?? '').toString();
      final lng = coordinates.isNotEmpty
          ? (coordinates[0] as num).toDouble()
          : null;
      final lat = coordinates.length > 1
          ? (coordinates[1] as num).toDouble()
          : null;
      if (lat != null && lng != null && id.isNotEmpty) {
        _coordinatesById[id] = (lat: lat, lng: lng);
      }
      final description =
          (properties['full_address'] ??
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
      throw Exception(
        'Mapbox Geocoding rechazo la consulta (${response.statusCode})',
      );
    }
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    final features = data['features'] as List<dynamic>? ?? [];
    if (features.isEmpty) throw Exception('Sin resultados');
    final first = features.first as Map<String, dynamic>;
    final properties = first['properties'] as Map<String, dynamic>? ?? {};
    final address =
        (properties['full_address'] ??
                properties['name'] ??
                'Ubicacion seleccionada')
            .toString();
    _reverseGeocodeCache[cacheKey] = (
      expiresAt: DateTime.now().add(const Duration(minutes: 10)),
      address: address,
    );
    return address;
  }
}
