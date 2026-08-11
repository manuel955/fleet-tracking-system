import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';

/// Cliente HTTP del backend Contabo. Se usa solo cuando VPS_API_BASE_URL
/// esta definido; Firebase sigue siendo el backend por defecto.
class VpsApiException implements Exception {
  final int statusCode;
  final String message;

  const VpsApiException(this.statusCode, this.message);

  @override
  String toString() => 'VpsApiException($statusCode): $message';
}

class VpsApiClient {
  static const _timeout = Duration(seconds: 15);

  static Uri _uri(String path) {
    final base =
        AppConfig.vpsApiBaseUrl.trim().replaceFirst(RegExp(r'/+$'), '');
    if (base.isEmpty) {
      throw StateError('El API VPS no esta configurado para esta build.');
    }
    return Uri.parse('$base${path.startsWith('/') ? path : '/$path'}');
  }

  static Future<Map<String, dynamic>> _request(
    String method,
    String path, {
    String? token,
    Map<String, dynamic>? body,
  }) async {
    final headers = <String, String>{'Accept': 'application/json'};
    if (body != null) headers['Content-Type'] = 'application/json';
    if (token != null && token.isNotEmpty) {
      headers['Authorization'] = 'Bearer $token';
    }

    final uri = _uri(path);
    final response = switch (method) {
      'GET' => await http.get(uri, headers: headers).timeout(_timeout),
      'POST' => await http
          .post(uri,
              headers: headers, body: body == null ? null : jsonEncode(body))
          .timeout(_timeout),
      _ => throw ArgumentError('Metodo VPS no soportado: $method'),
    };

    Map<String, dynamic> decoded = <String, dynamic>{};
    if (response.body.trim().isNotEmpty) {
      late final dynamic value;
      try {
        value = jsonDecode(response.body);
      } catch (_) {
        throw const VpsApiException(502, 'Respuesta invalida del API VPS.');
      }
      if (value is Map) decoded = Map<String, dynamic>.from(value);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw VpsApiException(
        response.statusCode,
        (decoded['error'] ?? decoded['message'] ?? 'Error del API VPS')
            .toString(),
      );
    }
    return decoded;
  }

  static Future<Map<String, dynamic>> login({
    required String email,
    required String password,
  }) =>
      _request('POST', '/api/v1/auth/login', body: {
        'email': email.trim().toLowerCase(),
        'password': password,
      });

  static Future<Map<String, dynamic>> register({
    required String email,
    required String password,
    required String displayName,
    String role = 'driver',
  }) =>
      _request('POST', '/api/v1/auth/register', body: {
        'email': email.trim().toLowerCase(),
        'password': password,
        'displayName': displayName.trim(),
        'role': role,
      });

  static Future<Map<String, dynamic>> me(String token) =>
      _request('GET', '/api/v1/auth/me', token: token);

  static Future<Map<String, dynamic>> driverMe(String token) =>
      _request('GET', '/api/v1/drivers/me', token: token);

  static Map<String, dynamic> normalizeTrip(Map<String, dynamic> trip) {
    final normalized = Map<String, dynamic>.from(trip);
    normalized['scheduledPickupLabel'] ??=
        normalized['scheduledPickupAt']?.toString();
    return normalized;
  }

  static Future<Map<String, dynamic>> setAvailability({
    required String token,
    required bool online,
  }) =>
      _request(
        'POST',
        '/api/v1/drivers/availability',
        token: token,
        body: {'online': online},
      );

  static Future<Map<String, dynamic>> updateLocation({
    required String token,
    required double latitude,
    required double longitude,
    double? accuracyM,
  }) =>
      _request(
        'POST',
        '/api/v1/drivers/location',
        token: token,
        body: {
          'latitude': latitude,
          'longitude': longitude,
          if (accuracyM != null) 'accuracyM': accuracyM,
        },
      );

  static Future<Map<String, dynamic>> getTrip({
    required String token,
    required String tripId,
  }) async {
    final result = await _request('GET', '/api/v1/trips/$tripId', token: token);
    return normalizeTrip(result);
  }

  static Future<Map<String, dynamic>> advanceTrip({
    required String token,
    required String tripId,
    required String action,
  }) =>
      _request(
        'POST',
        '/api/v1/trips/$tripId/action',
        token: token,
        body: {'action': action},
      );
}
