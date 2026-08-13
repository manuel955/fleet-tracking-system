import 'dart:async';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Aviso local cuando llega un push (conductor llegó, viaje modificado).
/// Un solo canal, importancia normal -- a diferencia de driver-app, acá no
/// hace falta un canal separado con sonido fuerte/TTS para "nuevo viaje".
class NotificationService {
  static const String _channelId = 'passenger_alert_channel';
  // Android fija el sonido la primera vez que crea un canal. El sufijo v2
  // garantiza que los teléfonos que ya tenían el canal silencioso reciban
  // un canal nuevo con tono audible.
  static const String _arrivalChannelId = 'passenger_driver_arrival_sound_v2';
  static final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  static bool _initialized = false;
  static String? _lastArrivalTripId;
  static final _openedController = StreamController<String>.broadcast();
  static String? _pendingOpenedPayload;

  static Stream<String> get openedPayloads => _openedController.stream;

  static String? takePendingOpenedPayload() {
    final payload = _pendingOpenedPayload;
    _pendingOpenedPayload = null;
    return payload;
  }

  static void _handleOpenedPayload(String? payload) {
    if (payload == null || payload.isEmpty) return;
    if (_openedController.hasListener) {
      _openedController.add(payload);
    } else {
      _pendingOpenedPayload = payload;
    }
  }

  static Future<void> initialize() async {
    if (_initialized) return;

    const channel = AndroidNotificationChannel(
      _channelId,
      'Avisos de viaje',
      description: 'Conductor llegó, cambios en el viaje.',
      importance: Importance.high,
    );
    const arrivalChannel = AndroidNotificationChannel(
      _arrivalChannelId,
      'Llegada del conductor',
      description: 'Aviso con sonido y vibración cuando el conductor llega.',
      importance: Importance.high,
      playSound: true,
      enableVibration: true,
    );

    final androidPlugin = _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >();
    await androidPlugin?.createNotificationChannel(channel);
    await androidPlugin?.createNotificationChannel(arrivalChannel);

    await _plugin.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@drawable/notification_icon'),
      ),
      onDidReceiveNotificationResponse: (response) {
        _handleOpenedPayload(response.payload);
      },
    );

    final launch = await _plugin.getNotificationAppLaunchDetails();
    if (launch?.didNotificationLaunchApp ?? false) {
      _handleOpenedPayload(launch?.notificationResponse?.payload);
    }

    _initialized = true;
  }

  static Future<void> showSimple(
    String title,
    String body, {
    String? payload,
  }) async {
    await initialize();
    await _plugin.show(
      DateTime.now().millisecondsSinceEpoch.remainder(100000),
      title,
      body,
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          'Avisos de viaje',
          channelDescription: 'Conductor llegó, cambios en el viaje.',
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
      payload: payload ?? 'passenger://home',
    );
  }

  static Future<void> showTripCancelled([
    String? reason,
    String? payload,
  ]) async {
    await showSimple(
      'Viaje cancelado',
      (reason == null || reason.trim().isEmpty)
          ? 'Tu viaje fue cancelado.'
          : reason.trim(),
      payload: payload,
    );
  }

  static Future<void> showDriverArrived([
    String? tripId,
    String? payload,
  ]) async {
    if (tripId != null && _lastArrivalTripId == tripId) return;
    if (tripId != null) _lastArrivalTripId = tripId;
    await initialize();
    await _plugin.show(
      1001,
      'Tu conductor llegó',
      'Tu conductor está en el punto de recogida.',
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _arrivalChannelId,
          'Llegada del conductor',
          channelDescription:
              'Aviso con sonido y vibración cuando el conductor llega.',
          importance: Importance.high,
          priority: Priority.high,
          playSound: true,
          enableVibration: true,
        ),
      ),
      payload: payload ?? (tripId == null ? null : 'passenger://trip/$tripId'),
    );
  }
}
