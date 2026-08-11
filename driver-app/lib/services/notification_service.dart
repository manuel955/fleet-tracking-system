import 'dart:async';
import 'dart:typed_data';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:shared_preferences/shared_preferences.dart';

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
  static const String _channelId = 'trip_alert_channel_v3';
  // Canal aparte, importancia normal (sin el patron de vibracion/TTS del de
  // arriba): para avisos que no necesitan interrumpir con sonido fuerte,
  // como aprobacion/rechazo de cuenta o un cambio de destino en un viaje.
  static const String _generalChannelId = 'general_alert_channel';
  static final Int64List _vibrationPattern =
      Int64List.fromList([0, 800, 400, 800, 400, 800]);
  static final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  static final FlutterTts _tts = FlutterTts();
  static bool _initialized = false;
  static bool _ttsInitialized = false;
  static const Duration _repeatAssignedAfter = Duration(seconds: 30);

  /// Converts the backend's localized label (for example
  /// "10/08, 10:39 p. m.") into natural speech for the driver's locale.
  /// Same-day assignments are intentionally announced as "Hoy a las ...";
  /// reading the numeric date aloud caused Android TTS to say "diez octavos".
  static String scheduledPickupText(String? label, {DateTime? now}) {
    final value = label?.trim() ?? '';
    if (value.isEmpty) return value;
    final match = RegExp(r'^\s*(\d{1,2})\s*[/-]\s*(\d{1,2})').firstMatch(value);
    if (match == null) return value;
    final day = int.tryParse(match.group(1)!) ?? -1;
    final month = int.tryParse(match.group(2)!) ?? -1;
    final today = now ?? DateTime.now();
    if (day != today.day || month != today.month) return value;

    var time = value.substring(match.end).trim();
    if (time.startsWith(',')) time = time.substring(1).trim();
    return time.isEmpty ? 'Hoy' : 'Hoy a las $time';
  }

  static int _notificationId(String key) {
    var hash = 0;
    for (final codeUnit in key.codeUnits) {
      hash = (hash * 31 + codeUnit) & 0x7fffffff;
    }
    return 1000 + (hash % 900000000);
  }

  static Future<bool> _claimEvent(String key) async {
    final prefs = await SharedPreferences.getInstance();
    final marker = 'notification_event:$key';
    if (prefs.getString(marker) == 'shown') return false;
    await prefs.setString(marker, 'shown');
    return true;
  }

  static Future<void> acknowledgeTripAssigned(String tripId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('notification_ack:assigned:$tripId', true);
  }

  static Future<void> _acknowledgeNotificationPayload(String payload) async {
    if (payload.startsWith('assigned:')) {
      await acknowledgeTripAssigned(payload.substring('assigned:'.length));
    }
  }

  static void _onNotificationResponse(NotificationResponse response) {
    final payload = response.payload;
    if (payload == null || payload.isEmpty) return;
    unawaited(_acknowledgeNotificationPayload(payload));
  }

  static Future<void> initialize() async {
    if (_initialized) return;

    final channel = AndroidNotificationChannel(
      _channelId,
      'Nuevo viaje asignado',
      description: 'Suena y vibra cuando el sistema te asigna un viaje.',
      importance: Importance.max,
      playSound: true,
      enableVibration: true,
      vibrationPattern: _vibrationPattern,
    );
    const generalChannel = AndroidNotificationChannel(
      _generalChannelId,
      'Avisos generales',
      description: 'Aprobacion de cuenta, cambios de viaje, etc.',
      importance: Importance.defaultImportance,
    );

    final androidPlugin = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    await androidPlugin?.createNotificationChannel(channel);
    await androidPlugin?.createNotificationChannel(generalChannel);

    await _plugin.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@drawable/notification_icon'),
      ),
      onDidReceiveNotificationResponse: _onNotificationResponse,
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
            if (locale.startsWith('es') &&
                (name.contains('female') || name.contains('#female'))) {
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
      await _tts.stop();
      await _tts.speak(text);
    } catch (_) {
      // Sin texto a voz disponible en este telefono; el sonido y la
      // vibracion de la notificacion igual avisan al conductor.
    }
  }

  // [scheduledPickupLabel] viene de Cloud Functions solo si el viaje fue
  // programado por el pasajero (ver dispatchScheduledTrips en
  // functions/index.js) -- en ese caso se avisa la hora en vez del
  // generico "nuevo servicio".
  static Future<void> showTripAssigned({
    String? tripId,
    String? scheduledPickupLabel,
  }) async {
    final spokenSchedule = scheduledPickupText(scheduledPickupLabel);
    final hasSchedule =
        scheduledPickupLabel != null && scheduledPickupLabel.isNotEmpty;
    final eventKey =
        'assigned:${tripId ?? DateTime.now().millisecondsSinceEpoch}';
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool('notification_ack:$eventKey') == true) return;
    final lastShownAt = prefs.getInt('notification_last_shown:$eventKey');
    final now = DateTime.now().millisecondsSinceEpoch;
    if (lastShownAt != null &&
        now - lastShownAt < _repeatAssignedAfter.inMilliseconds) {
      return;
    }
    await prefs.setInt('notification_last_shown:$eventKey', now);
    await initialize();
    await _plugin.show(
      _notificationId(eventKey),
      hasSchedule ? 'Viaje Programado Asignado' : 'Nuevo Servicio Asignado',
      hasSchedule
          ? 'Viaje programado para ${spokenSchedule.isEmpty ? scheduledPickupLabel : spokenSchedule}. Abre la app para ver los detalles.'
          : 'Tienes un viaje nuevo. Abre la app para ver los detalles.',
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          'Nuevo viaje asignado',
          channelDescription:
              'Suena y vibra cuando el sistema te asigna un viaje.',
          importance: Importance.max,
          priority: Priority.max,
          playSound: true,
          enableVibration: true,
          vibrationPattern: _vibrationPattern,
          onlyAlertOnce: false,
          ticker: 'Nuevo servicio asignado',
        ),
      ),
      payload: eventKey,
    );
    _speak(hasSchedule
        ? (spokenSchedule.isEmpty
            ? 'Nuevo servicio programado para las $scheduledPickupLabel'
            : spokenSchedule)
        : 'Nuevo servicio asignado');
  }

  // El pasajero cambio el destino de un viaje ya asignado: alerta urgente
  // con sonido, vibracion y aviso hablado.
  static Future<void> showTripUpdated({
    String? tripId,
    String? destinationAddress,
  }) async {
    final eventKey =
        'updated:${tripId ?? ''}:${destinationAddress ?? DateTime.now().millisecondsSinceEpoch}';
    if (!await _claimEvent(eventKey)) return;
    await showSimple(
        'Viaje actualizado', 'El pasajero cambió el destino del viaje.');
    await _speak(destinationAddress == null || destinationAddress.trim().isEmpty
        ? 'Cambio de destino'
        : 'Cambio de destino. Nuevo destino: ${destinationAddress.trim()}');
  }

  static Future<void> showPlaceAssigned(String name, String type) async {
    await initialize();
    await _plugin.show(
      901,
      '$type asignado',
      name,
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _generalChannelId,
          'Avisos generales',
          channelDescription: 'Aprobacion de cuenta, cambios de viaje, etc.',
          importance: Importance.high,
          priority: Priority.high,
          ongoing: true,
          autoCancel: false,
        ),
      ),
    );
  }

  static Future<void> showTripCancelled(
      {String? tripId, String? reason}) async {
    final detail = reason == null || reason.trim().isEmpty
        ? 'El viaje fue cancelado.'
        : reason.trim();
    final eventKey =
        'cancelled:${tripId ?? DateTime.now().millisecondsSinceEpoch}';
    if (!await _claimEvent(eventKey)) return;
    await showSimple('Viaje cancelado', detail);
    await _speak('Atención. Viaje cancelado. $detail');
  }

  // Aviso simple. Se mantiene en el canal urgente para que los eventos de
  // viaje no queden silenciosos en telefonos que ya crearon el canal anterior.
  static Future<void> showSimple(String title, String body) async {
    await initialize();
    await _plugin.show(
      DateTime.now().millisecondsSinceEpoch.remainder(100000),
      title,
      body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          'Alertas de viajes',
          channelDescription: 'Alertas con sonido, vibración y voz.',
          importance: Importance.max,
          priority: Priority.max,
          playSound: true,
          enableVibration: true,
          vibrationPattern: _vibrationPattern,
          onlyAlertOnce: false,
          ticker: title,
        ),
      ),
    );
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
