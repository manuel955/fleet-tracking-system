import 'dart:convert';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:http/http.dart' as http;
import '../config.dart';
import 'auth_service.dart';
import 'notification_service.dart';

// Corre en un isolate propio cuando llega un mensaje FCM con la app
// minimizada o cerrada. Cloud Functions manda mensajes solo-datos (sin
// bloque `notification`) a proposito: asi este handler corre siempre y
// puede reproducir la alerta completa (notificacion por el canal
// trip_alert_channel_v2 + voz), en vez de dejar que el sistema muestre una
// notificacion generica sin TTS. Con la app visible el mensaje llega por
// onMessage y lo atiende el polling de main.dart, no este handler.
@pragma('vm:entry-point')
Future<void> pushBackgroundHandler(RemoteMessage message) async {
  switch (message.data['type']) {
    case 'trip_assigned':
      await NotificationService.showTripAssigned(
        scheduledPickupLabel: message.data['scheduledPickupLabel'] as String?,
      );
      break;
    case 'trip_updated':
      await NotificationService.showTripUpdated();
      break;
    case 'approval_status':
      final status = message.data['status'];
      if (status == 'approved') {
        await NotificationService.showSimple(
          'Cuenta aprobada',
          'Ya puedes empezar a recibir viajes.',
        );
      } else if (status == 'rejected') {
        final reason = message.data['rejectionReason'] as String? ?? '';
        await NotificationService.showSimple(
          'Registro rechazado',
          reason.isNotEmpty ? reason : 'Revisa tus documentos e intenta de nuevo.',
        );
      }
      break;
  }
}

/// Registra el dispositivo en FCM y guarda el token en
/// `drivers/{uid}/fcmToken` para que Cloud Functions pueda avisarle al
/// conductor de un viaje nuevo aunque la app este minimizada o cerrada
/// (el polling de 5s solo funciona con el proceso vivo).
class PushService {
  static Future<void> initialize() async {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(pushBackgroundHandler);
  }

  /// Obtiene el token FCM y lo sube al nodo del conductor. Se llama al
  /// arrancar (con el uid anonimo ya disponible) y queda escuchando
  /// rotaciones de token, que FCM puede hacer en cualquier momento.
  static Future<void> registerToken() async {
    try {
      final token = await FirebaseMessaging.instance.getToken();
      if (token != null) await _saveToken(token);
      FirebaseMessaging.instance.onTokenRefresh.listen((t) {
        _saveToken(t);
      });
    } catch (_) {
      // Sin Google Play Services o sin red: el conductor sigue operativo
      // via polling; solo pierde el aviso con la app cerrada.
    }
  }

  static Future<void> _saveToken(String token) async {
    final auth = await AuthService.currentSession();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/drivers/${auth['uid']}.json?auth=${auth['idToken']}',
    );
    await http.patch(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'fcmToken': token}),
    );
  }
}
