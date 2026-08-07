import 'dart:async';
import 'dart:convert';
import 'dart:ui';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import 'auth_service.dart';
import 'notification_service.dart';

const String _notificationChannelId = 'fleet_tracking_channel';
const int _notificationId = 888;
const Duration _gpsFixTimeout = Duration(seconds: 4);
const Duration _networkTimeout = Duration(seconds: 8);
const Duration _maxAcceptedLastKnownAge = Duration(seconds: 30);

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
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: _gpsFixTimeout,
      );
      return isUsableCoordinates(position.latitude, position.longitude)
          ? position
          : null;
    } catch (_) {
      final last = await Geolocator.getLastKnownPosition();
      if (last == null ||
          !isUsableCoordinates(last.latitude, last.longitude) ||
          !_isRecentPosition(last)) {
        return null;
      }
      return last;
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
        _maxAcceptedLastKnownAge;
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

  Timer? timer;
  var sendInFlight = false;
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
    timer?.cancel();
    service.stopSelf();
  });

  _log(service,
      'Servicio iniciado. Enviando cada ${AppConfig.locationIntervalSeconds}s.');

  // El timer se crea antes del primer GPS. Obtener un fix puede tardar varios
  // segundos y no debe bloquear el resto del ciclo del servicio.
  timer = Timer.periodic(
    AppConfig.locationInterval,
    (_) {
      // No superponer lecturas GPS/red: si un ciclo tarda mas de 5s, el
      // siguiente espera al siguiente intervalo. Asi no se multiplican las
      // escrituras ni los heartbeats por una mala cobertura.
      if (sendInFlight) return;
      sendInFlight = true;
      unawaited(_sendCurrentLocation(service).whenComplete(() {
        sendInFlight = false;
      }));
      // FCM es inmediato cuando llega, pero Huawei puede retrasar el
      // despertar de ese isolate con la pantalla apagada. Este chequeo corre
      // dentro del foreground service que ya mantiene vivo el GPS y cubre
      // asignaciones, cancelaciones y cambios de destino aunque no llegue el
      // push.
      unawaited(checkTripAlerts());
    },
  );

  // Primer envio inmediato, sin retrasar el arranque del timer.
  sendInFlight = true;
  unawaited(_sendCurrentLocation(service).whenComplete(() {
    sendInFlight = false;
  }));
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

  if (previousTripId != currentTripId) {
    await NotificationService.showTripAssigned(
      tripId: currentTripId,
      scheduledPickupLabel: trip['scheduledPickupLabel']?.toString(),
    );
  } else if (prefs.getString(_alertedDestinationKey) != null &&
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

Future<void> _sendCurrentLocation(ServiceInstance service) async {
  try {
    final serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      _log(service, 'GPS del teléfono desactivado. Actívalo en ajustes.');
      return;
    }

    final permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      _log(service,
          'Permiso de ubicación no otorgado ("$permission"). Abre la app y concede permiso.');
      return;
    }

    _log(service, 'Obteniendo posición GPS...');

    Position position;
    try {
      position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: _gpsFixTimeout,
      );
    } catch (e) {
      _log(service,
          'getCurrentPosition falló ($e), probando última posición conocida...');
      final last = await Geolocator.getLastKnownPosition();
      if (last == null || !LocationService._isRecentPosition(last)) {
        _log(service, 'No hay ninguna posición disponible todavía.');
        return;
      }
      position = last;
    }

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
