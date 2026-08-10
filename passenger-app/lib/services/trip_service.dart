import 'dart:convert';
import 'dart:math';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import 'auth_service.dart';

/// Pide viajes y consulta su estado. El emparejamiento con el conductor
/// mas cercano lo hace Cloud Functions en el servidor apenas se crea el
/// viaje (status: 'searching') -- esta clase solo crea el registro inicial
/// y despues consulta como va evolucionando.
class TripService {
  static const driverLocationFreshness = Duration(seconds: 30);
  static const _networkTimeout = Duration(seconds: 15);
  static const _createTripTimeout = Duration(seconds: 25);
  static const _tripCachePrefix = 'cached_trip_';

  /// Devuelve null para respuestas HTML o cualquier contenido que no sea JSON.
  /// Las pasarelas pueden devolver una página de error antes de que la función
  /// alcance nuestro handler; la app debe mostrar un mensaje útil en ese caso.
  static dynamic decodeResponseBody(String raw) {
    final normalized = raw.trim();
    if (normalized.isEmpty) return <String, dynamic>{};
    try {
      return jsonDecode(normalized);
    } on FormatException {
      return null;
    }
  }

  static bool hasFreshDriverLocation(
    Map<String, dynamic> location, {
    DateTime? now,
  }) {
    final lastUpdate = location['lastUpdate'];
    if (lastUpdate is! num || lastUpdate <= 0) return false;
    final age =
        (now ?? DateTime.now()).millisecondsSinceEpoch - lastUpdate.toInt();
    return age >= 0 && age <= driverLocationFreshness.inMilliseconds;
  }

  static String _newRequestId() {
    final random = Random.secure();
    return List<int>.generate(
      16,
      (_) => random.nextInt(256),
    ).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  }

  static Future<String> requestRide({
    required double pickupLat,
    required double pickupLng,
    required int passengerCount,
    String? pickupAddress,
    double? destinationLat,
    double? destinationLng,
    String? destinationAddress,
    int? scheduledPickupAt,
  }) async {
    if (passengerCount < 1 || passengerCount > 45) {
      throw ArgumentError.value(
        passengerCount,
        'passengerCount',
        'Debe estar entre 1 y 45 pasajeros.',
      );
    }
    final auth = await AuthService.signInAnonymously();
    final prefs = await SharedPreferences.getInstance();
    final requestPayload = <String, dynamic>{
      'pickupLat': pickupLat,
      'pickupLng': pickupLng,
      'pickupAddress': pickupAddress,
      'destinationLat': destinationLat,
      'destinationLng': destinationLng,
      'destinationAddress': destinationAddress,
      'passengerCount': passengerCount,
      'scheduledPickupAt': scheduledPickupAt,
    };
    final fingerprint = jsonEncode(requestPayload);
    var requestId = prefs.getString('pending_trip_request_id');
    if (requestId == null ||
        prefs.getString('pending_trip_request_fingerprint') != fingerprint) {
      requestId = _newRequestId();
      await prefs.setString('pending_trip_request_id', requestId);
      await prefs.setString('pending_trip_request_fingerprint', fingerprint);
    }

    final response = await http
        .post(
          Uri.parse('${AppConfig.cloudFunctionsBaseUrl}/createPassengerTrip'),
          headers: {
            'Authorization': 'Bearer ${auth['idToken']}',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({'requestId': requestId, ...requestPayload}),
        )
        .timeout(_createTripTimeout);
    final data = decodeResponseBody(response.body);
    if (data == null) {
      throw Exception(
        'El servicio de viajes no respondió correctamente. Intenta de nuevo en unos minutos.',
      );
    }
    String? tripId;
    if (response.statusCode == 200 || response.statusCode == 201) {
      tripId = data is Map ? data['tripId']?.toString() : null;
    } else if (response.statusCode == 409 && data is Map) {
      // Si el servidor encontró otro viaje abierto, se recupera en lugar de
      // crear uno nuevo o dejar al pasajero en una pantalla vacía.
      tripId = data['existingTripId']?.toString();
    }
    if (tripId == null || tripId.isEmpty) {
      throw Exception(
        data is Map
            ? data['error'] ?? 'No se pudo solicitar el viaje.'
            : 'No se pudo solicitar el viaje.',
      );
    }

    final recoveredTrip = await getTrip(tripId);
    final isScheduled = recoveredTrip?['status'] == 'scheduled';
    // Un viaje programado se guarda aparte del viaje "activo" (inmediato):
    // el pasajero puede tener un viaje programado esperando su hora Y pedir
    // un viaje para ahora mismo al mismo tiempo -- ver getScheduledTripId.
    if (isScheduled) {
      await prefs.setString('scheduled_trip_id', tripId);
    } else {
      await prefs.setString('active_trip_id', tripId);
    }
    await prefs.remove('pending_trip_request_id');
    await prefs.remove('pending_trip_request_fingerprint');
    return tripId;
  }

  static Future<Map<String, dynamic>?> getTrip(String tripId) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}',
    );
    final response = await http.get(uri).timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(
        'Firebase rechazo la consulta (${response.statusCode}): ${response.body}',
      );
    }
    final data = decodeResponseBody(response.body);
    if (data == null && response.body.trim() != 'null') {
      throw Exception('Firebase devolvió una respuesta inválida.');
    }
    final prefs = await SharedPreferences.getInstance();
    if (data == null) {
      await prefs.remove('$_tripCachePrefix$tripId');
      return null;
    }
    final trip = Map<String, dynamic>.from(data);
    await prefs.setString('$_tripCachePrefix$tripId', jsonEncode(trip));
    return trip;
  }

  static Future<Map<String, dynamic>?> getCachedTrip(String tripId) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('$_tripCachePrefix$tripId');
    if (raw == null) return null;
    try {
      return Map<String, dynamic>.from(jsonDecode(raw) as Map);
    } catch (_) {
      await prefs.remove('$_tripCachePrefix$tripId');
      return null;
    }
  }

  static Future<Map<String, dynamic>?> getDriverLocation(
    String driverId,
  ) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/driverLocations/$driverId.json?auth=${auth['idToken']}',
    );
    final response = await http.get(uri).timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(
        'Firebase rechazo la consulta (${response.statusCode}): ${response.body}',
      );
    }
    final data = decodeResponseBody(response.body);
    if (data == null && response.body.trim() != 'null') {
      throw Exception('Firebase devolvió una respuesta inválida.');
    }
    return data == null ? null : Map<String, dynamic>.from(data);
  }

  static Future<void> cancelTrip(String tripId, {String? reason}) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}',
    );
    final response = await http
        .patch(
          uri,
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'status': 'cancelled',
            'cancelledBy': 'passenger',
            'cancelledAt': DateTime.now().millisecondsSinceEpoch,
            'cancelReason': ?reason,
          }),
        )
        .timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(
        'Firebase rechazo la cancelacion (${response.statusCode}): ${response.body}',
      );
    }
    await _clearIfMatches(tripId);
  }

  static Future<void> _clearIfMatches(String tripId) async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getString('active_trip_id') == tripId) {
      await prefs.remove('active_trip_id');
    }
    if (prefs.getString('scheduled_trip_id') == tripId) {
      await prefs.remove('scheduled_trip_id');
    }
    await prefs.remove('$_tripCachePrefix$tripId');
  }

  // Cambia el destino de un viaje ya en curso. Las reglas de RTDB solo lo
  // permiten mientras el viaje no este 'completed'/'cancelled' (ver
  // database/firebase-rules.json); dispara notifyTripUpdated en Cloud
  // Functions, que avisa al conductor.
  static Future<void> updateDestination(
    String tripId, {
    required double destinationLat,
    required double destinationLng,
    required String destinationAddress,
  }) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}',
    );
    final response = await http
        .patch(
          uri,
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'destinationLat': destinationLat,
            'destinationLng': destinationLng,
            'destinationAddress': destinationAddress,
          }),
        )
        .timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(
        'Firebase rechazo la modificacion (${response.statusCode}): ${response.body}',
      );
    }
  }

  static Future<void> retrySearch(String tripId) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}',
    );
    final response = await http
        .patch(
          uri,
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'status': 'searching',
            'requestedAt': DateTime.now().millisecondsSinceEpoch,
            'noDriversReason': null,
            'rejectedDriverIds': <String, dynamic>{},
          }),
        )
        .timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(
        'Firebase rechazo el reintento (${response.statusCode}): ${response.body}',
      );
    }
  }

  /// Historial de viajes del pasajero (pestaña Actividad), mas recientes
  /// primero. Por defecto solo trae los ultimos 7 dias (para no guardar/
  /// mostrar historial indefinido); pasar `last7Days: false` cuando se
  /// necesitan todos (p.ej. al borrar todo en el logout).
  ///
  /// Esto pasa por una Cloud Function (getMyTrips) en vez de consultar
  /// `/trips.json` directo: las reglas de RTDB solo autorizan lectura por
  /// registro individual (para que un pasajero no pueda leer los viajes de
  /// otro), y ese tipo de regla no alcanza para un query orderBy/equalTo
  /// contra el nodo completo -- Firebase evalua el permiso en el nodo
  /// consultado, no por cada hijo que matchea, asi que ese query siempre
  /// daria "permission denied". La Cloud Function usa el Admin SDK (que
  /// ignora las reglas) y valida el idToken para solo devolver los viajes
  /// del uid autenticado.
  static Future<List<MapEntry<String, Map<String, dynamic>>>> getMyTrips({
    bool last7Days = true,
  }) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse(
      '${AppConfig.cloudFunctionsBaseUrl}/getMyTrips'
      '${last7Days ? '' : '?all=true'}',
    );
    final response = await http
        .get(uri, headers: {'Authorization': 'Bearer ${auth['idToken']}'})
        .timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(
        'No se pudo obtener el historial (${response.statusCode}): ${response.body}',
      );
    }
    final data = decodeResponseBody(response.body);
    if (data == null && response.body.trim() != 'null') {
      throw Exception(
        'El servicio de historial no respondió correctamente. Intenta de nuevo en unos minutos.',
      );
    }
    if (data == null) return [];
    final map = Map<String, dynamic>.from(data);
    final entries = map.entries
        .map((e) => MapEntry(e.key, Map<String, dynamic>.from(e.value as Map)))
        .toList();
    entries.sort((a, b) {
      final aTime = a.value['requestedAt'] as int? ?? 0;
      final bTime = b.value['requestedAt'] as int? ?? 0;
      return bTime.compareTo(aTime);
    });
    return entries;
  }

  static Future<Map<String, dynamic>> submitFeedback({
    required String tripId,
    int? rating,
    String comment = '',
    String incidentCategory = 'none',
    String incidentDetails = '',
  }) async {
    final auth = await AuthService.signInAnonymously();
    final response = await http
        .post(
          Uri.parse('${AppConfig.cloudFunctionsBaseUrl}/submitTripFeedback'),
          headers: {
            'Authorization': 'Bearer ${auth['idToken']}',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            'tripId': tripId,
            'rating': rating,
            'comment': comment,
            'incidentCategory': incidentCategory,
            'incidentDetails': incidentDetails,
          }),
        )
        .timeout(_networkTimeout);
    final payload = decodeResponseBody(response.body);
    if (payload == null) {
      throw Exception(
        'El servicio de comentarios no respondió correctamente. Intenta de nuevo en unos minutos.',
      );
    }
    if (response.statusCode != 200) {
      throw Exception(
        payload is Map
            ? payload['error'] ?? 'No se pudo guardar tu comentario.'
            : 'No se pudo guardar tu comentario.',
      );
    }
    return Map<String, dynamic>.from(payload['feedback'] as Map);
  }

  static Future<
    ({
      MapEntry<String, Map<String, dynamic>>? active,
      MapEntry<String, Map<String, dynamic>>? scheduled,
    })
  >
  recoverOpenTrips() async {
    final trips = await getMyTrips(last7Days: false);
    MapEntry<String, Map<String, dynamic>>? active;
    MapEntry<String, Map<String, dynamic>>? scheduled;
    for (final entry in trips) {
      final status = entry.value['status']?.toString();
      if (status == 'completed' || status == 'cancelled') continue;
      if (status == 'scheduled') {
        scheduled ??= entry;
      } else {
        active ??= entry;
      }
    }
    final prefs = await SharedPreferences.getInstance();
    if (active != null) {
      await prefs.setString('active_trip_id', active.key);
    }
    if (scheduled != null) {
      await prefs.setString('scheduled_trip_id', scheduled.key);
    }
    return (active: active, scheduled: scheduled);
  }

  /// Borra TODOS los viajes del pasajero (sin importar la fecha) -- se usa
  /// al cerrar sesion para no dejar historial guardado en Firebase
  /// asociado a una cuenta que ya no se va a volver a usar.
  static Future<void> deleteMyTrips() async {
    final auth = await AuthService.signInAnonymously();
    final trips = await getMyTrips(last7Days: false);
    if (trips.isEmpty) return;
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/trips.json?auth=${auth['idToken']}',
    );
    final body = <String, dynamic>{for (final e in trips) e.key: null};
    final response = await http
        .patch(
          uri,
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode(body),
        )
        .timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(
        'Firebase rechazo el borrado (${response.statusCode}): ${response.body}',
      );
    }
  }

  /// Ultimos destinos usados (para la lista "Recientes" al buscar
  /// destino), mas recientes primero, sin duplicados consecutivos.
  static Future<List<({String label, double lat, double lng})>>
  getRecentDestinations({int limit = 3}) async {
    final trips = await getMyTrips();
    final results = <({String label, double lat, double lng})>[];
    final seenLabels = <String>{};

    for (final entry in trips) {
      final trip = entry.value;
      final lat = trip['destinationLat'] as num?;
      final lng = trip['destinationLng'] as num?;
      final label = trip['destinationAddress'] as String?;
      if (lat == null || lng == null || label == null || label.isEmpty) {
        continue;
      }
      if (!seenLabels.add(label)) continue;
      results.add((label: label, lat: lat.toDouble(), lng: lng.toDouble()));
      if (results.length >= limit) break;
    }
    return results;
  }

  static Future<String?> getActiveTripId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('active_trip_id');
  }

  static Future<void> clearActiveTrip() async {
    final prefs = await SharedPreferences.getInstance();
    final tripId = prefs.getString('active_trip_id');
    await prefs.remove('active_trip_id');
    if (tripId != null) await prefs.remove('$_tripCachePrefix$tripId');
  }

  static Future<String?> getScheduledTripId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('scheduled_trip_id');
  }

  static Future<void> clearScheduledTrip() async {
    final prefs = await SharedPreferences.getInstance();
    final tripId = prefs.getString('scheduled_trip_id');
    await prefs.remove('scheduled_trip_id');
    if (tripId != null) await prefs.remove('$_tripCachePrefix$tripId');
  }

  // Cuando Cloud Functions despacha un viaje programado (deja de estar
  // 'scheduled' y pasa a buscar/asignar conductor), pasa a tratarse como
  // el viaje activo normal -- se mueve de la clave 'scheduled_trip_id' a
  // 'active_trip_id' para que quede consistente si se reabre la app.
  static Future<void> promoteScheduledTrip(String tripId) async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getString('scheduled_trip_id') == tripId) {
      await prefs.remove('scheduled_trip_id');
      await prefs.setString('active_trip_id', tripId);
    }
  }
}
