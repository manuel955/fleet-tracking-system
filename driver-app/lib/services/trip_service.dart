import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';
import 'auth_service.dart';
import 'vps_api_client.dart';

class TripStateConflictException implements Exception {
  final String message;
  final String? currentStatus;

  const TripStateConflictException(this.message, {this.currentStatus});

  @override
  String toString() => message;
}

class TripActionRejectedException implements Exception {
  final String message;
  final int? distanceMeters;

  const TripActionRejectedException(this.message, {this.distanceMeters});

  @override
  String toString() => message;
}

/// Lee/escribe el nodo `trips/{tripId}` y el `status`/`currentTripId` del
/// conductor en `drivers/{uid}`. El emparejamiento automatico (elegir al
/// conductor mas cercano y asignarlo, sin pedir confirmacion) lo hace Cloud
/// Functions en el servidor; esta clase solo consulta el estado del viaje
/// y avanza su ciclo de vida (el conductor no puede rechazar ni cancelar).
class TripService {
  static const _networkTimeout = Duration(seconds: 15);

  static Future<Map<String, dynamic>?> getMyDriverNode(String uid) async {
    if (AppConfig.useVpsBackend) {
      final auth = await AuthService.currentSession();
      return VpsApiClient.driverMe(auth['idToken'].toString());
    }
    final auth = await AuthService.currentSession();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=${auth['idToken']}',
    );
    final response = await http.get(uri).timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(
          'Firebase rechazo la consulta (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
    return data == null ? null : Map<String, dynamic>.from(data);
  }

  static Future<Map<String, dynamic>?> getTrip(String tripId) async {
    if (AppConfig.useVpsBackend) {
      final auth = await AuthService.currentSession();
      try {
        return await VpsApiClient.getTrip(
          token: auth['idToken'].toString(),
          tripId: tripId,
        );
      } on VpsApiException catch (error) {
        if (error.statusCode == 404) return null;
        rethrow;
      }
    }
    final auth = await AuthService.currentSession();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}',
    );
    final response = await http.get(uri).timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(
          'Firebase rechazo la consulta (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
    return data == null ? null : Map<String, dynamic>.from(data);
  }

  static Future<void> advanceTrip(String tripId, String newStatus) async {
    if (AppConfig.useVpsBackend) {
      final auth = await AuthService.currentSession();
      final action = switch (newStatus) {
        'arrived_at_pickup' => 'arrive',
        'in_progress' => 'start',
        'completed' => 'complete',
        _ => newStatus,
      };
      try {
        await VpsApiClient.advanceTrip(
          token: auth['idToken'].toString(),
          tripId: tripId,
          action: action,
        );
        return;
      } on VpsApiException catch (error) {
        if (error.statusCode == 409) {
          throw TripStateConflictException(error.message);
        }
        rethrow;
      }
    }
    final auth = await AuthService.currentSession();
    final uri = Uri.parse(
      '${AppConfig.cloudFunctionsBaseUrl}/advanceDriverTrip',
    );
    final response = await http
        .post(
          uri,
          headers: {
            'Authorization': 'Bearer ${auth['idToken']}',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({'tripId': tripId, 'newStatus': newStatus}),
        )
        .timeout(_networkTimeout);
    final payload = jsonDecode(response.body);
    final data = payload is Map
        ? Map<String, dynamic>.from(payload)
        : <String, dynamic>{};
    if (response.statusCode == 409) {
      throw TripStateConflictException(
        data['error']?.toString() ??
            'El viaje cambio de estado. Actualizando la pantalla.',
        currentStatus: data['currentStatus']?.toString(),
      );
    }
    if (response.statusCode == 422) {
      throw TripActionRejectedException(
        data['error']?.toString() ??
            'No se puede confirmar esta accion todavia.',
        distanceMeters: (data['distanceMeters'] as num?)?.round(),
      );
    }
    if (response.statusCode != 200) {
      throw Exception(data['error']?.toString() ??
          'El servidor rechazo el avance del viaje (${response.statusCode}).');
    }
  }

  /// Solicita al backend iniciar o terminar la disponibilidad. El backend
  /// conserva la carrera contra una asignacion y registra cada desconexion.
  static Future<void> setAvailability(String uid,
      {required bool online}) async {
    final auth =
        await AuthService.currentSession().timeout(const Duration(seconds: 10));
    if (AppConfig.useVpsBackend) {
      await VpsApiClient.setAvailability(
        token: auth['idToken'].toString(),
        online: online,
      );
      return;
    }
    final uri = Uri.parse(
      '${AppConfig.cloudFunctionsBaseUrl}/setDriverAvailability',
    );
    final response = await http
        .post(
          uri,
          headers: {
            'Authorization': 'Bearer ${auth['idToken']}',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({'uid': uid, 'online': online}),
        )
        .timeout(const Duration(seconds: 15));
    final payload = jsonDecode(response.body);
    final data = payload is Map
        ? Map<String, dynamic>.from(payload)
        : <String, dynamic>{};
    if (response.statusCode == 200) return;
    throw Exception(data['error']?.toString() ??
        'El backend rechazo el cambio de disponibilidad (${response.statusCode}).');
  }
}
