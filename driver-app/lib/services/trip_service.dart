import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';
import 'auth_service.dart';

/// Lee/escribe el nodo `trips/{tripId}` y el `status`/`currentTripId` del
/// conductor en `drivers/{uid}`. El emparejamiento automatico (elegir al
/// conductor mas cercano y asignarlo, sin pedir confirmacion) lo hace Cloud
/// Functions en el servidor; esta clase solo consulta el estado del viaje
/// y avanza su ciclo de vida (el conductor no puede rechazar ni cancelar).
class TripService {
  static Future<Map<String, dynamic>?> getMyDriverNode(String uid) async {
    final auth = await AuthService.currentSession();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=${auth['idToken']}',
    );
    final response = await http.get(uri);
    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la consulta (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
    return data == null ? null : Map<String, dynamic>.from(data);
  }

  static Future<Map<String, dynamic>?> getTrip(String tripId) async {
    final auth = await AuthService.currentSession();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}',
    );
    final response = await http.get(uri);
    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la consulta (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
    return data == null ? null : Map<String, dynamic>.from(data);
  }

  static const Map<String, String> _timestampFieldByStatus = {
    'arrived_at_pickup': 'arrivedAt',
    'in_progress': 'inProgressAt',
    'completed': 'completedAt',
  };

  static Future<void> advanceTrip(String tripId, String newStatus) async {
    final auth = await AuthService.currentSession();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}',
    );
    final timestampField = _timestampFieldByStatus[newStatus];
    final body = {
      'status': newStatus,
      if (timestampField != null) timestampField: DateTime.now().millisecondsSinceEpoch,
    };

    final response = await http.patch(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode(body),
    );
    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo el avance del viaje (${response.statusCode}): ${response.body}');
    }
  }

  /// Marca al conductor como disponible ('online') o lo retira del
  /// emparejamiento automatico (borra el campo 'status'). No toca
  /// 'currentTripId': eso lo maneja Cloud Functions al asignar/liberar.
  static Future<void> setAvailability(String uid, {required bool online}) async {
    final auth = await AuthService.currentSession();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=${auth['idToken']}',
    );

    if (!online) {
      final response = await http.patch(
        uri,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'status': null}),
      );
      if (response.statusCode != 200) {
        throw Exception('Firebase rechazo el cambio de disponibilidad (${response.statusCode}): ${response.body}');
      }
      return;
    }

    // Ponerse "online" solo debe aplicar si, en el momento exacto de
    // escribir, el conductor sigue sin viaje asignado. Un PATCH simple es
    // vulnerable a una carrera: la app pudo leer currentTripId=null al
    // arrancar, pero si esa peticion se demora (red lenta justo al cerrar
    // la app) y mientras tanto Cloud Functions asigna un viaje, el PATCH
    // llega despues y pisa 'status' a 'online' sin tocar currentTripId --
    // el conductor queda "disponible" en el dashboard con un viaje en
    // curso. Se usa ETag/if-match (mismo patron que claimDriver/
    // releaseDriver en functions/matching.js) para que la escritura se
    // rechace si currentTripId cambio entre el GET y el PUT.
    final getRes = await http.get(uri, headers: {'X-Firebase-ETag': 'true'});
    if (getRes.statusCode != 200) {
      throw Exception('Firebase rechazo la consulta (${getRes.statusCode}): ${getRes.body}');
    }
    final etag = getRes.headers['etag'];
    final current = jsonDecode(getRes.body);
    if (current is! Map || current['currentTripId'] != null) {
      return; // Ya tiene (o le acaban de asignar) un viaje: no pisar su disponibilidad.
    }

    final updated = {...Map<String, dynamic>.from(current), 'status': 'online'};
    final putRes = await http.put(
      uri,
      headers: {
        'Content-Type': 'application/json',
        if (etag != null) 'if-match': etag,
      },
      body: jsonEncode(updated),
    );
    if (putRes.statusCode == 412) {
      return; // Perdimos la carrera contra una asignacion: no reintentar.
    }
    if (putRes.statusCode != 200) {
      throw Exception('Firebase rechazo el cambio de disponibilidad (${putRes.statusCode}): ${putRes.body}');
    }
  }
}
