import 'dart:async';
import 'dart:convert';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import '../config.dart';
import 'auth_service.dart';
import 'notification_service.dart';
import 'vps_api_client.dart';

// Corre en un isolate propio con la app minimizada/cerrada. Cloud Functions
// manda mensajes solo-datos (sin bloque `notification`), igual que para el
// conductor -- ver driver-app/lib/services/push_service.dart.
@pragma('vm:entry-point')
Future<void> pushBackgroundHandler(RemoteMessage message) async {
  switch (message.data['type']) {
    case 'driver_arrived':
      await NotificationService.showDriverArrived(
        message.data['tripId']?.toString(),
      );
      break;
    case 'trip_updated':
      await NotificationService.showSimple(
        'Viaje actualizado',
        'El destino de tu viaje cambió.',
      );
      break;
    case 'trip_cancelled':
      await NotificationService.showTripCancelled(
        message.data['reason']?.toString(),
      );
      break;
    case 'trip_completed':
      await NotificationService.showSimple(
        'Viaje finalizado',
        'Tu viaje terminó. Abre la app para calificarlo.',
      );
      break;
  }
}

/// Registra el dispositivo en FCM y guarda el token en
/// `passengers/{uid}/fcmToken` para que Cloud Functions pueda avisarle al
/// pasajero (llegada del conductor, cambios de viaje) aunque la app este
/// minimizada o cerrada.
class PushService {
  static StreamSubscription<String>? _tokenRefreshSubscription;

  static Future<void> initialize() async {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(pushBackgroundHandler);
  }

  static Future<void> registerToken() async {
    try {
      final token = await FirebaseMessaging.instance.getToken();
      if (token != null) await _saveToken(token);
      _tokenRefreshSubscription ??= FirebaseMessaging.instance.onTokenRefresh
          .listen((t) => unawaited(_saveToken(t)));
    } catch (_) {
      // Sin Google Play Services o sin red: el pasajero sigue operativo
      // via el polling de la pantalla de viaje activo, solo pierde el
      // aviso con la app cerrada.
    }
  }

  static Future<void> _saveToken(String token) async {
    final auth = await AuthService.signInAnonymously();
    if (AppConfig.useVpsBackend) {
      await VpsApiClient.registerDeviceToken(
        token: auth['idToken'].toString(),
        deviceToken: token,
        platform: _platform,
      );
      return;
    }
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/passengers/${auth['uid']}.json?auth=${auth['idToken']}',
    );
    await http
        .patch(
          uri,
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'fcmToken': token}),
        )
        .timeout(const Duration(seconds: 10));
  }

  static String get _platform {
    if (kIsWeb) return 'web';
    return defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android';
  }
}
