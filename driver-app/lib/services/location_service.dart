import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:ui';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import 'auth_service.dart';
import 'notification_service.dart';
import 'vps_api_client.dart';

const String _notificationChannelId = 'fleet_tracking_channel';
const int _notificationId = 888;
const Duration _uiGpsFixTimeout = Duration(seconds: 12);
const Duration _networkTimeout = Duration(seconds: 8);
const Duration _maxStreamPositionAge = Duration(seconds: 15);
// No mostramos una coordenada con un radio de error de una cuadra como si
// fuera exacta. El servicio sigue intentando hasta obtener una fijacion mejor.
const double _maxAcceptedAccuracyMeters = 35;
const double _stationarySpeedMetersPerSecond = 1.5;
// A phone reporting ~50-60m horizontal accuracy can drift a whole block
// while parked. A slow vehicle (speed <=1.5m/s) is still allowed to move
// once it clears this envelope or reports a real speed.
const double _stationaryJitterMeters = 60;
const int _locationDistanceFilterMeters = 5;
const Duration _locationUpdateInterval = Duration(seconds: 2);

/// Clave persistida que indica si el usuario pidio explicitamente el
/// rastreo. Android puede reiniciar el servicio en segundo plano por su
/// cuenta (START_STICKY, a nivel nativo del plugin) sin que el codigo Dart
/// lo pida; revisando esta bandera al entrar, el propio servicio se
/// autodetiene si nadie lo solicito, garantizando que el rastreo sea
/// siempre manual.
const String _trackingEnabledKey = 'tracking_enabled';
const String _alertedTripIdKey = 'background_alert_trip_id';
const String _alertedDestinationKey = 'background_alert_destination';

/// Servicio en segundo plano que obtiene el GPS y lo envia a Firebase.
///
/// Cada paso emite un evento `debug_log` hacia la UI (ver main.dart) para
/// poder ver en pantalla, en tiempo real, en que punto exacto falla si algo
/// no funciona: GPS apagado, permiso no otorgado, o error al enviar a
/// Firebase. Tambien emite `location_update` con la posicion obtenida para
/// que el mapa de la app se mueva y confirmes visualmente que es tu
/// ubicacion real (no 0,0).
class LocationService {
  static Future<void> initialize() async {
    final service = FlutterBackgroundService();

    // Android exige que el canal de notificacion exista ANTES de llamar a
    // startForeground(); si no, la app se cierra con
    // CannotPostForegroundServiceNotificationException ("Bad notification
    // for startForeground").
    const channel = AndroidNotificationChannel(
      _notificationChannelId,
      'Rastreo de flota',
      description: 'Notificacion del servicio de rastreo en segundo plano.',
      importance: Importance.low,
    );

    await FlutterLocalNotificationsPlugin()
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(channel);

    await service.configure(
      androidConfiguration: AndroidConfiguration(
        onStart: onServiceStart,
        autoStart: false,
        // El plugin puede volver a levantar el servicio despues de reiniciar
        // Android; onServiceStart lo detiene inmediatamente si el conductor
        // no habia iniciado un turno.
        autoStartOnBoot: true,
        isForegroundMode: true,
        notificationChannelId: _notificationChannelId,
        initialNotificationTitle: 'Rastreo de flota activo',
        initialNotificationContent:
            'Enviando tu ubicación cada ${AppConfig.locationIntervalSeconds}s',
        foregroundServiceNotificationId: _notificationId,
      ),
      iosConfiguration: IosConfiguration(
        autoStart: false,
        onForeground: onServiceStart,
        onBackground: onIosBackground,
      ),
    );
  }

  static Future<void> start() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_trackingEnabledKey, true);
    await FlutterBackgroundService().startService();
  }

  static Future<void> stop() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_trackingEnabledKey, false);
    FlutterBackgroundService().invoke('stopService');
  }

  static Future<bool> isRunning() => FlutterBackgroundService().isRunning();

  /// Obtiene una posicion desde el isolate de la interfaz para que el mapa
  /// pueda centrarse al abrir la app, sin esperar el primer tick del servicio.
  static Future<Position?> getCurrentPosition() async {
    if (!await Geolocator.isLocationServiceEnabled()) return null;

    final permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      return null;
    }

    try {
      final position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.bestForNavigation,
        timeLimit: _uiGpsFixTimeout,
      );
      return shouldPublishPosition(position, null) ? position : null;
    } catch (_) {
      // A lastKnownPosition is not a fresh heartbeat. The map can simply
      // retain its previous marker when the provider has no new fix.
      return null;
    }
  }

  /// Publica un heartbeat GPS desde el isolate visible. El servicio en
  /// segundo plano sigue enviando cada cinco segundos, pero este primer
  /// envio evita que el dashboard marque al conductor como desconectado
  /// mientras Android termina de levantar el foreground service.
  static Future<Position?> sendCurrentLocationNow() async {
    final position = await getCurrentPosition();
    if (position == null) return null;

    try {
      final auth = await AuthService.currentSession();
      final token = auth['idToken'];
      if (token is! String || token.isEmpty) {
        return null;
      }

      if (AppConfig.useVpsBackend) {
        await VpsApiClient.updateLocation(
          token: token,
          latitude: position.latitude,
          longitude: position.longitude,
          accuracyM: position.accuracy,
        );
        return position;
      }

      final heading = position.heading.isFinite ? position.heading : 0.0;
      final payload = jsonEncode({
        'lat': position.latitude,
        'lng': position.longitude,
        'heading': heading,
      });
      final response = await http
          .post(
            Uri.parse(
                '${AppConfig.cloudFunctionsBaseUrl}/updateDriverLocation'),
            headers: {
              'Authorization': 'Bearer $token',
              'Content-Type': 'application/json',
            },
            body: payload,
          )
          .timeout(_networkTimeout);
      if (response.statusCode == 200) {
        return position;
      }
    } catch (_) {
      // El servicio en segundo plano reintentara en el siguiente ciclo.
    }
    return null;
  }

  static bool _isRecentPosition(Position position, {DateTime? now}) {
    final reference = now ?? DateTime.now();
    return reference.difference(position.timestamp).abs() <=
        _maxStreamPositionAge;
  }

  /// Filters stale, imprecise and stationary GPS jitter before it reaches
  /// Firebase. A parked phone can report small movements around its real
  /// location; those must not make the driver marker wander on the map.
  static bool shouldPublishPosition(Position position, Position? previous,
      {DateTime? now}) {
    if (!isUsableCoordinates(position.latitude, position.longitude)) {
      return false;
    }
    if (!position.accuracy.isFinite ||
        position.accuracy > _maxAcceptedAccuracyMeters) {
      return false;
    }
    if (!_isRecentPosition(position, now: now)) return false;
    if (previous == null) return true;

    final distance = Geolocator.distanceBetween(
      previous.latitude,
      previous.longitude,
      position.latitude,
      position.longitude,
    );
    final speed = position.speed.isFinite ? position.speed : 0.0;
    if (speed <= _stationarySpeedMetersPerSecond &&
        distance < _stationaryJitterMeters) {
      return false;
    }
    return true;
  }

  static bool isUsableCoordinates(double latitude, double longitude) {
    return latitude.isFinite &&
        longitude.isFinite &&
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180 &&
        !(latitude == 0.0 && longitude == 0.0);
  }
}

// Los callbacks del servicio en segundo plano deben ser funciones de nivel
// superior (no metodos estaticos de una clase): el motor de Flutter las
// busca por nombre desde codigo nativo al arrancar el isolate, y sin esto
// falla con "must be annotated" / no logra iniciar el isolate en segundo
// plano.

@pragma('vm:entry-point')
bool onIosBackground(ServiceInstance service) => true;

@pragma('vm:entry-point')
void onServiceStart(ServiceInstance service) async {
  // Necesario para que los plugins (geolocator, shared_preferences, http)
  // funcionen dentro del isolate separado del servicio en segundo plano.
  DartPluginRegistrant.ensureInitialized();

  final prefs = await SharedPreferences.getInstance();
  if (prefs.getBool(_trackingEnabledKey) != true) {
    // Android reinicio el servicio solo (comportamiento nativo del
    // sistema), pero el usuario no pidio rastrear. Se detiene de inmediato.
    service.stopSelf();
    return;
  }

  if (service is AndroidServiceInstance) {
    service.setAsForegroundService();
  }

  StreamSubscription<Position>? positionSubscription;
  Timer? alertTimer;
  var sendInFlight = false;
  Position? pendingPosition;
  Position? lastAcceptedPosition;
  var alertCheckInFlight = false;

  Future<void> checkTripAlerts() async {
    if (alertCheckInFlight) return;
    alertCheckInFlight = true;
    try {
      await _checkTripAlerts();
    } finally {
      alertCheckInFlight = false;
    }
  }

  service.on('stopService').listen((event) {
    alertTimer?.cancel();
    positionSubscription?.cancel();
    service.stopSelf();
  });

  _log(service,
      'Servicio iniciado. GPS continuo cada ${_locationUpdateInterval.inSeconds}s.');

  Future<void> drainLocationQueue() async {
    if (sendInFlight) return;
    sendInFlight = true;
    try {
      while (pendingPosition != null) {
        final position = pendingPosition;
        pendingPosition = null;
        if (position == null || !LocationService._isRecentPosition(position)) {
          continue;
        }
        await _sendPosition(service, position);
      }
    } finally {
      sendInFlight = false;
      // A stream callback can arrive between the final queue check and this
      // flag reset. Kick the drain again so that sample is never stranded.
      if (pendingPosition != null) unawaited(drainLocationQueue());
    }
  }

  void onPosition(Position position) {
    if (!LocationService.shouldPublishPosition(
        position, lastAcceptedPosition)) {
      _log(service, 'GPS descartado: precisión/deriva insuficiente.');
      return;
    }
    lastAcceptedPosition = position;
    // Keep only the newest sample while the network request is in flight;
    // never replay an old coordinate after connectivity returns.
    pendingPosition = position;
    unawaited(drainLocationQueue());
  }

  final LocationSettings locationSettings = Platform.isAndroid
      ? AndroidSettings(
          accuracy: LocationAccuracy.bestForNavigation,
          distanceFilter: _locationDistanceFilterMeters,
          intervalDuration: _locationUpdateInterval,
          forceLocationManager: true,
        )
      : const LocationSettings(
          accuracy: LocationAccuracy.high,
          distanceFilter: _locationDistanceFilterMeters,
        );
  positionSubscription = Geolocator.getPositionStream(
    locationSettings: locationSettings,
  ).listen(
    onPosition,
    onError: (Object error, StackTrace stack) {
      _log(service, 'Error en stream GPS: $error');
    },
    cancelOnError: false,
  );

  // El GPS ya no depende de este timer. El chequeo de asignaciones sigue
  // teniendo polling para complementar FCM cuando Android/Huawei retrasan el
  // isolate de notificaciones.
  alertTimer = Timer.periodic(AppConfig.locationInterval, (_) {
    unawaited(checkTripAlerts());
  });
  unawaited(checkTripAlerts());
}

Future<void> _checkTripAlerts() async {
  final auth = await AuthService.currentSession();
  final uid = auth['uid'];
  final token = auth['idToken'];
  if (uid is! String || uid.isEmpty || token is! String || token.isEmpty) {
    return;
  }

  final driverResponse = await http
      .get(
          Uri.parse('${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=$token'))
      .timeout(_networkTimeout);
  if (driverResponse.statusCode != 200) return;
  final rawDriver = jsonDecode(driverResponse.body);
  if (rawDriver is! Map) return;
  final driver = Map<String, dynamic>.from(rawDriver);
  final currentTripId = driver['currentTripId']?.toString();
  final prefs = await SharedPreferences.getInstance();
  final previousTripId = prefs.getString(_alertedTripIdKey);

  // Al cancelar, el backend libera currentTripId. Conservamos el ultimo
  // viaje para poder leer su estado y avisar aunque el push haya sido
  // retrasado o perdido con la pantalla apagada.
  if (currentTripId == null || currentTripId.isEmpty) {
    if (previousTripId != null && previousTripId.isNotEmpty) {
      final closedTrip = await _readTrip(previousTripId, token);
      if (closedTrip?['status']?.toString() == 'cancelled') {
        await NotificationService.showTripCancelled(
          tripId: previousTripId,
          reason: closedTrip?['cancelReason']?.toString(),
        );
      }
    }
    await prefs.remove(_alertedTripIdKey);
    await prefs.remove(_alertedDestinationKey);
    return;
  }

  final trip = await _readTrip(currentTripId, token);
  if (trip == null || trip['driverId']?.toString() != uid) return;
  final status = trip['status']?.toString();
  if (status == 'cancelled') {
    await NotificationService.showTripCancelled(
      tripId: currentTripId,
      reason: trip['cancelReason']?.toString(),
    );
    await prefs.remove(_alertedTripIdKey);
    await prefs.remove(_alertedDestinationKey);
    return;
  }

  const activeStatuses = {'accepted', 'arrived_at_pickup', 'in_progress'};
  if (!activeStatuses.contains(status)) return;

  final destinationSignature = [
    trip['destinationLat'],
    trip['destinationLng'],
    trip['destinationAddress'],
  ].map((value) => value?.toString() ?? '').join('|');

  // The notification service throttles this to once every 30s until the
  // driver taps it or the active-trip screen acknowledges it. Calling it on
  // every poll is therefore intentional: it keeps the alert alive when FCM
  // was delayed or lost while the foreground service is running.
  await NotificationService.showTripAssigned(
    tripId: currentTripId,
    scheduledPickupLabel: trip['scheduledPickupLabel']?.toString(),
  );
  if (previousTripId == currentTripId &&
      prefs.getString(_alertedDestinationKey) != null &&
      prefs.getString(_alertedDestinationKey) != destinationSignature) {
    await NotificationService.showTripUpdated(
      tripId: currentTripId,
      destinationAddress: trip['destinationAddress']?.toString(),
    );
  }

  await prefs.setString(_alertedTripIdKey, currentTripId);
  await prefs.setString(_alertedDestinationKey, destinationSignature);
}

Future<Map<String, dynamic>?> _readTrip(String tripId, String token) async {
  final response = await http
      .get(Uri.parse(
          '${AppConfig.firebaseDbUrl}/trips/$tripId.json?auth=$token'))
      .timeout(_networkTimeout);
  if (response.statusCode != 200) return null;
  final raw = jsonDecode(response.body);
  return raw is Map ? Map<String, dynamic>.from(raw) : null;
}

Future<void> _sendPosition(ServiceInstance service, Position position) async {
  try {
    if (!LocationService.shouldPublishPosition(position, null)) {
      _log(service, 'Posicion GPS antigua o imprecisa. Se descarta.');
      return;
    }
    // The stream supplies every sample. This method only sends a fresh
    // sample; it never starts a second getCurrentPosition polling loop or
    // falls back to lastKnownPosition.

    if (!LocationService.isUsableCoordinates(
        position.latitude, position.longitude)) {
      _log(service, 'Posición inválida (0,0). Se descarta este envío.');
      return;
    }

    _log(service,
        'GPS ok: ${position.latitude.toStringAsFixed(5)}, ${position.longitude.toStringAsFixed(5)}');

    // El token se obtiene de la misma sesion que usa el turno. La escritura
    // pasa por Cloud Functions, que valida el uid y actualiza solo los campos
    // de ubicacion; asi el telefono no necesita escribir el nodo padre RTDB.
    final auth = await AuthService.currentSession();
    final token = auth['idToken'];
    if (token is! String || token.isEmpty) {
      _log(service, 'Sesion sin token; no se publica la ubicacion.');
      return;
    }

    if (AppConfig.useVpsBackend) {
      await VpsApiClient.updateLocation(
        token: token,
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyM: position.accuracy,
      );
      _log(service, 'Enviado al backend VPS correctamente.');
      service.invoke('location_update', {
        'lat': position.latitude,
        'lng': position.longitude,
        'heading': position.heading.isFinite ? position.heading : 0.0,
        'time': DateTime.now().toIso8601String(),
      });
      return;
    }

    final heading = position.heading.isFinite ? position.heading : 0.0;
    final payload = jsonEncode({
      'lat': position.latitude,
      'lng': position.longitude,
      'heading': heading,
    });
    final response = await http
        .post(
          Uri.parse('${AppConfig.cloudFunctionsBaseUrl}/updateDriverLocation'),
          headers: {
            'Authorization': 'Bearer $token',
            'Content-Type': 'application/json',
          },
          body: payload,
        )
        .timeout(_networkTimeout);

    if (response.statusCode == 200) {
      _log(service, 'Enviado a Firebase correctamente.');
      service.invoke('location_update', {
        'lat': position.latitude,
        'lng': position.longitude,
        'heading': heading,
        'time': DateTime.now().toIso8601String(),
      });
    } else {
      final failed = response;
      _log(service, 'Firebase respondió ${failed.statusCode}: ${failed.body}');
    }
  } catch (e) {
    _log(service, 'Error inesperado: $e');
  }
}

void _log(ServiceInstance service, String message) {
  // Tambien se imprime en consola (visible con `flutter run` / `adb logcat`)
  // para poder diagnosticar sin depender solo de la pantalla del telefono.
  // ignore: avoid_print
  print('[LocationService] $message');
  service.invoke('debug_log', {
    'message': message,
    'time': DateTime.now().toIso8601String(),
  });
}
