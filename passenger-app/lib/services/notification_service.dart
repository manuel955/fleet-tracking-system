import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Aviso local cuando llega un push (conductor llegó, viaje modificado).
/// Un solo canal, importancia normal -- a diferencia de driver-app, acá no
/// hace falta un canal separado con sonido fuerte/TTS para "nuevo viaje".
class NotificationService {
  static const String _channelId = 'passenger_alert_channel';
  static const String _arrivalChannelId = 'passenger_driver_arrival_silent';
  static final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  static bool _initialized = false;
  static String? _lastArrivalTripId;

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
      description: 'Aviso visual y silencioso cuando el conductor llega.',
      importance: Importance.high,
      playSound: false,
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
    );

    _initialized = true;
  }

  static Future<void> showSimple(String title, String body) async {
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
    );
  }

  static Future<void> showTripCancelled([String? reason]) async {
    await showSimple(
      'Viaje cancelado',
      (reason == null || reason.trim().isEmpty)
          ? 'Tu viaje fue cancelado.'
          : reason.trim(),
    );
  }

  static Future<void> showDriverArrived([String? tripId]) async {
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
              'Aviso visual y silencioso cuando el conductor llega.',
          importance: Importance.high,
          priority: Priority.high,
          playSound: false,
          enableVibration: true,
        ),
      ),
    );
  }
}
