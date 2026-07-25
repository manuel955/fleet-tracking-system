import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Aviso local cuando llega un push (conductor llegó, viaje modificado).
/// Un solo canal, importancia normal -- a diferencia de driver-app, acá no
/// hace falta un canal separado con sonido fuerte/TTS para "nuevo viaje".
class NotificationService {
  static const String _channelId = 'passenger_alert_channel';
  static final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  static bool _initialized = false;

  static Future<void> initialize() async {
    if (_initialized) return;

    const channel = AndroidNotificationChannel(
      _channelId,
      'Avisos de viaje',
      description: 'Conductor llegó, cambios en el viaje.',
      importance: Importance.high,
    );

    await _plugin
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(channel);

    await _plugin.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
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
}
