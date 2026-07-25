import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import 'auth_service.dart';

/// Pide viajes y consulta su estado. El emparejamiento con el conductor
/// mas cercano lo hace Cloud Functions en el servidor apenas se crea el
/// viaje (status: 'searching') -- esta clase solo crea el registro inicial
/// y despues consulta como va evolucionando.
class TripService {
  static Future<String> requestRide({
    required double pickupLat,
    required double pickupLng,
    required String passengerName,
    required String passengerPhone,
    String? pickupAddress,
    double? destinationLat,
    double? destinationLng,
    String? destinationAddress,
    String? scheduledPickupLabel,
    int? scheduledPickupAt,
  }) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/trips.json?auth=${auth['idToken']}');

    final response = await http.post(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'passengerId': auth['uid'],
        'passengerName': passengerName,
        'passengerPhone': passengerPhone,
        'pickupLat': pickupLat,
        'pickupLng': pickupLng,
        if (pickupAddress != null) 'pickupAddress': pickupAddress,
        if (destinationLat != null) 'destinationLat': destinationLat,
        if (destinationLng != null) 'destinationLng': destinationLng,
        if (destinationAddress != null) 'destinationAddress': destinationAddress,
        // Hora de recogida elegida, en formato 12h AM/PM (ej. "3:30 PM") --
        // solo para mostrar. scheduledPickupAt (epoch ms) es lo que usa
        // Cloud Functions (dispatchScheduledTrips) para decidir cuando
        // despachar de verdad -- ver request_ride_screen.dart.
        if (scheduledPickupLabel != null) 'scheduledPickupLabel': scheduledPickupLabel,
        if (scheduledPickupAt != null) 'scheduledPickupAt': scheduledPickupAt,
        // Con hora programada el viaje espera en 'scheduled' -- Cloud
        // Functions lo despacha (busca/asigna conductor) mas cerca de la
        // hora elegida, no de inmediato como un pedido normal.
        'status': scheduledPickupAt != null ? 'scheduled' : 'searching',
        'requestedAt': DateTime.now().millisecondsSinceEpoch,
        'rejectedDriverIds': <String, dynamic>{},
      }),
    );

    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la solicitud (${response.statusCode}): ${response.body}');
    }

    final tripId = jsonDecode(response.body)['name'] as String;
    final prefs = await SharedPreferences.getInstance();
    // Un viaje programado se guarda aparte del viaje "activo" (inmediato):
    // el pasajero puede tener un viaje programado esperando su hora Y pedir
    // un viaje para ahora mismo al mismo tiempo -- ver getScheduledTripId.
    if (scheduledPickupAt != null) {
      await prefs.setString('scheduled_trip_id', tripId);
    } else {
      await prefs.setString('active_trip_id', tripId);
    }
    return tripId;
  }

  static Future<Map<String, dynamic>?> getTrip(String tripId) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}');
    final response = await http.get(uri);
    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la consulta (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
    return data == null ? null : Map<String, dynamic>.from(data);
  }

  static Future<Map<String, dynamic>?> getDriverLocation(String driverId) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/drivers/$driverId.json?auth=${auth['idToken']}');
    final response = await http.get(uri);
    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la consulta (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
    return data == null ? null : Map<String, dynamic>.from(data);
  }

  static Future<void> cancelTrip(String tripId, {String? reason}) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}');
    final response = await http.patch(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'status': 'cancelled',
        'cancelledBy': 'passenger',
        'cancelledAt': DateTime.now().millisecondsSinceEpoch,
        if (reason != null) 'cancelReason': reason,
      }),
    );
    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la cancelacion (${response.statusCode}): ${response.body}');
    }
    await _clearIfMatches(tripId);
  }

  static Future<void> _clearIfMatches(String tripId) async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getString('active_trip_id') == tripId) await prefs.remove('active_trip_id');
    if (prefs.getString('scheduled_trip_id') == tripId) await prefs.remove('scheduled_trip_id');
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
    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}');
    final response = await http.patch(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'destinationLat': destinationLat,
        'destinationLng': destinationLng,
        'destinationAddress': destinationAddress,
      }),
    );
    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la modificacion (${response.statusCode}): ${response.body}');
    }
  }

  static Future<void> retrySearch(String tripId) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=${auth['idToken']}');
    final response = await http.patch(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'status': 'searching',
        'requestedAt': DateTime.now().millisecondsSinceEpoch,
        'rejectedDriverIds': <String, dynamic>{},
      }),
    );
    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo el reintento (${response.statusCode}): ${response.body}');
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
  static Future<List<MapEntry<String, Map<String, dynamic>>>> getMyTrips({bool last7Days = true}) async {
    final auth = await AuthService.signInAnonymously();
    final uri = Uri.parse(
      '${AppConfig.cloudFunctionsBaseUrl}/getMyTrips'
      '?idToken=${auth['idToken']}${last7Days ? '' : '&all=true'}',
    );
    final response = await http.get(uri);
    if (response.statusCode != 200) {
      throw Exception('No se pudo obtener el historial (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
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

  /// Borra TODOS los viajes del pasajero (sin importar la fecha) -- se usa
  /// al cerrar sesion para no dejar historial guardado en Firebase
  /// asociado a una cuenta que ya no se va a volver a usar.
  static Future<void> deleteMyTrips() async {
    final auth = await AuthService.signInAnonymously();
    final trips = await getMyTrips(last7Days: false);
    if (trips.isEmpty) return;
    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/trips.json?auth=${auth['idToken']}');
    final body = <String, dynamic>{for (final e in trips) e.key: null};
    final response = await http.patch(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode(body),
    );
    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo el borrado (${response.statusCode}): ${response.body}');
    }
  }

  /// Ultimos destinos usados (para la lista "Recientes" al buscar
  /// destino), mas recientes primero, sin duplicados consecutivos.
  static Future<List<({String label, double lat, double lng})>> getRecentDestinations({int limit = 3}) async {
    final trips = await getMyTrips();
    final results = <({String label, double lat, double lng})>[];
    final seenLabels = <String>{};

    for (final entry in trips) {
      final trip = entry.value;
      final lat = trip['destinationLat'] as num?;
      final lng = trip['destinationLng'] as num?;
      final label = trip['destinationAddress'] as String?;
      if (lat == null || lng == null || label == null || label.isEmpty) continue;
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
    await prefs.remove('active_trip_id');
  }

  static Future<String?> getScheduledTripId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('scheduled_trip_id');
  }

  static Future<void> clearScheduledTrip() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('scheduled_trip_id');
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
