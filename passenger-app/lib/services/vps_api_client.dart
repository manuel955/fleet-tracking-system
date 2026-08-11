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
    final base = AppConfig.vpsApiBaseUrl.trim().replaceFirst(
      RegExp(r'/+$'),
      '',
    );
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
      'POST' =>
        await http
            .post(
              uri,
              headers: headers,
              body: body == null ? null : jsonEncode(body),
            )
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
  }) => _request(
    'POST',
    '/api/v1/auth/login',
    body: {'email': email.trim().toLowerCase(), 'password': password},
  );

  static Future<Map<String, dynamic>> register({
    required String email,
    required String password,
    required String displayName,
    String role = 'passenger',
  }) => _request(
    'POST',
    '/api/v1/auth/register',
    body: {
      'email': email.trim().toLowerCase(),
      'password': password,
      'displayName': displayName.trim(),
      'role': role,
    },
  );

  static Future<Map<String, dynamic>> me(String token) =>
      _request('GET', '/api/v1/auth/me', token: token);

  static Future<List<Map<String, dynamic>>> listTrips({
    required String token,
    int limit = 50,
  }) async {
    final base = AppConfig.vpsApiBaseUrl.trim().replaceFirst(
      RegExp(r'/+$'),
      '',
    );
    final uri = Uri.parse(
      '$base/api/v1/trips',
    ).replace(queryParameters: {'limit': limit.toString()});
    final response = await http
        .get(
          uri,
          headers: {
            'Accept': 'application/json',
            'Authorization': 'Bearer $token',
          },
        )
        .timeout(_timeout);
    late final dynamic value;
    try {
      value = response.body.trim().isEmpty ? <dynamic>[] : jsonDecode(response.body);
    } catch (_) {
      throw const VpsApiException(502, 'Respuesta invalida del API VPS.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final message = value is Map
          ? (value['error'] ?? value['message'] ?? 'Error del API VPS')
          : 'Error del API VPS';
      throw VpsApiException(response.statusCode, message.toString());
    }
    if (value is! List) {
      throw const VpsApiException(502, 'Respuesta invalida del API VPS.');
    }
    return value
        .whereType<Map>()
        .map((trip) => normalizeTrip(Map<String, dynamic>.from(trip)))
        .toList();
  }

  static Map<String, dynamic> normalizeTrip(Map<String, dynamic> trip) {
    final normalized = Map<String, dynamic>.from(trip);
    normalized['pickupAddress'] ??= normalized['originAddress'];
    normalized['pickupLat'] ??= normalized['originLat'];
    normalized['pickupLng'] ??= normalized['originLng'];
    normalized['scheduledPickupLabel'] ??= normalized['scheduledPickupAt']
        ?.toString();
    return normalized;
  }

  static Future<Map<String, dynamic>> createTrip({
    required String token,
    required double pickupLat,
    required double pickupLng,
    required String pickupAddress,
    required double destinationLat,
    required double destinationLng,
    required String destinationAddress,
    required int passengerCount,
    int? scheduledPickupAt,
  }) async {
    final body = <String, dynamic>{
      'pickupLat': pickupLat,
      'pickupLng': pickupLng,
      'pickupAddress': pickupAddress,
      'destinationLat': destinationLat,
      'destinationLng': destinationLng,
      'destinationAddress': destinationAddress,
      'passengerCount': passengerCount,
    };
    if (scheduledPickupAt != null) {
      body['scheduledPickupAt'] = scheduledPickupAt;
    }
    final result = await _request(
      'POST',
      '/api/v1/trips',
      token: token,
      body: body,
    );
    return normalizeTrip(result);
  }

  static Future<Map<String, dynamic>?> getTrip({
    required String token,
    required String tripId,
  }) async {
    try {
      return normalizeTrip(
        await _request('GET', '/api/v1/trips/$tripId', token: token),
      );
    } on VpsApiException catch (error) {
      if (error.statusCode == 404) return null;
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> cancelTrip({
    required String token,
    required String tripId,
    String? reason,
  }) async {
    final result = await _request(
      'POST',
      '/api/v1/trips/$tripId/cancel',
      token: token,
      body: {if (reason != null && reason.trim().isNotEmpty) 'reason': reason},
    );
    return normalizeTrip(result);
  }

  static Future<Map<String, dynamic>> retryTrip({
    required String token,
    required String tripId,
  }) async {
    final result = await _request(
      'POST',
      '/api/v1/trips/$tripId/retry',
      token: token,
    );
    return normalizeTrip(result);
  }

  static Future<Map<String, dynamic>> submitFeedback({
    required String token,
    required String tripId,
    required int rating,
    String comment = '',
  }) async {
    return _request(
      'POST',
      '/api/v1/trips/$tripId/feedback',
      token: token,
      body: {'rating': rating, 'comment': comment},
    );
  }
}
