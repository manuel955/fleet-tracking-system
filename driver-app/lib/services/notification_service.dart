import 'dart:typed_data';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_tts/flutter_tts.dart';

/// Alerta con sonido, vibracion y voz cuando Cloud Functions le asigna un
/// viaje nuevo al conductor. Es un canal separado del de rastreo en
/// segundo plano (location_service.dart, importancia baja y silencioso a
/// proposito): este necesita importancia alta para que Android reproduzca
/// sonido y muestre la notificacion emergente (heads-up).
class NotificationService {
  // "_v2": Android fija la configuracion de vibracion de un canal la
  // primera vez que se crea y ya no la actualiza aunque el codigo cambie
  // despues -- se cambia el id para forzar un canal nuevo con el patron de
  // vibracion explicito (el enableVibration simple, sin patron, no vibraba
  // de forma confiable en algunos telefonos Samsung).
  static const String _channelId = 'trip_alert_channel_v2';
  static final Int64List _vibrationPattern = Int64List.fromList([0, 800, 400, 800, 400, 800]);
  static final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  static final FlutterTts _tts = FlutterTts();
  static bool _initialized = false;
  static bool _ttsInitialized = false;

  static Future<void> initialize() async {
    if (_initialized) return;

    final channel = AndroidNotificationChannel(
      _channelId,
      'Nuevo viaje asignado',
      description: 'Suena y vibra cuando el sistema te asigna un viaje.',
      importance: Importance.high,
      playSound: true,
      enableVibration: true,
      vibrationPattern: _vibrationPattern,
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

  // El motor de texto a voz de Android no siempre deja elegir genero de
  // forma directa; se busca entre las voces en espanol una marcada como
  // femenina y, si el motor del telefono no expone esa info, se sube el
  // tono (pitch) como aproximacion -- es el truco mas compatible entre
  // fabricantes para que sí o sí suene una voz mas aguda/femenina.
  static Future<void> _initTts() async {
    if (_ttsInitialized) return;

    await _tts.setLanguage('es-ES');
    await _tts.setSpeechRate(0.5);
    await _tts.setPitch(1.3);

    try {
      final voices = await _tts.getVoices;
      if (voices is List) {
        Map? femaleVoice;
        for (final v in voices) {
          if (v is Map) {
            final locale = v['locale']?.toString().toLowerCase() ?? '';
            final name = v['name']?.toString().toLowerCase() ?? '';
            if (locale.startsWith('es') && (name.contains('female') || name.contains('#female'))) {
              femaleVoice = v;
              break;
            }
          }
        }
        if (femaleVoice != null) {
          await _tts.setVoice({
            'name': femaleVoice['name'].toString(),
            'locale': femaleVoice['locale'].toString(),
          });
        }
      }
    } catch (_) {
      // El motor TTS de este telefono no expone voces por genero; se queda
      // con el pitch mas alto como aproximacion.
    }

    _ttsInitialized = true;
  }

  static Future<void> _speak(String text) async {
    try {
      await _initTts();
      await _tts.speak(text);
    } catch (_) {
      // Sin texto a voz disponible en este telefono; el sonido y la
      // vibracion de la notificacion igual avisan al conductor.
    }
  }

  static Future<void> showTripAssigned() async {
    await initialize();
    await _plugin.show(
      900,
      'Nuevo Servicio Asignado',
      'Tienes un viaje nuevo. Abre la app para ver los detalles.',
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          'Nuevo viaje asignado',
          channelDescription: 'Suena y vibra cuando el sistema te asigna un viaje.',
          importance: Importance.high,
          priority: Priority.high,
          playSound: true,
          enableVibration: true,
          vibrationPattern: _vibrationPattern,
        ),
      ),
    );
    _speak('Nuevo servicio asignado');
  }

  // Se llama al cerrar sesion: retira cualquier notificacion de este canal
  // que siga visible y corta la voz si estaba hablando en ese momento.
  static Future<void> cancelAll() async {
    await initialize();
    await _plugin.cancelAll();
    try {
      await _tts.stop();
    } catch (_) {
      // Sin motor TTS activo en este momento: no hay nada que detener.
    }
  }
}
