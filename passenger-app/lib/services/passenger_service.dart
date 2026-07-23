import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import 'auth_service.dart';
import 'trip_service.dart';

/// Registro del pasajero: nombre, telefono y una foto de su credencial
/// (DNI/carnet). A diferencia de la app del conductor, esta foto NO se usa
/// para reconocimiento facial -- solo se guarda como referencia. El
/// registro se hace una sola vez; no se vuelve a pedir en aperturas
/// posteriores de la app (el flag "registered" si se persiste en disco).
class PassengerService {
  static Future<bool> isRegistered() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool('registered') ?? false;
  }

  static Future<Map<String, String>?> cachedProfile() async {
    final prefs = await SharedPreferences.getInstance();
    final name = prefs.getString('passenger_name');
    final phone = prefs.getString('passenger_phone');
    if (name == null || phone == null) return null;
    return {'name': name, 'phone': phone};
  }

  static Future<void> registerPassenger({
    required String name,
    required String phone,
    required Uint8List photoBytes,
  }) async {
    final auth = await AuthService.signInAnonymously();
    final uid = auth['uid'] as String;
    final idToken = auth['idToken'] as String;

    final photoUrl = await _uploadCredentialPhoto(uid, idToken, photoBytes);

    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/passengers/$uid.json?auth=$idToken',
    );
    final response = await http.put(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'name': name,
        'phone': phone,
        'credentialPhotoUrl': photoUrl,
        'registeredAt': DateTime.now().millisecondsSinceEpoch,
      }),
    );

    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo el registro (${response.statusCode}): ${response.body}');
    }

    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('registered', true);
    await prefs.setString('passenger_name', name);
    await prefs.setString('passenger_phone', phone);
  }

  /// Cierra sesion: borra el historial de viajes, el perfil y la foto de
  /// credencial guardados en Firebase para esta cuenta (para no acumular
  /// informacion de cuentas que ya no se van a volver a usar), y despues
  /// limpia todo lo local para que la app vuelva a pedir el registro.
  /// Si el borrado remoto falla (sin red, etc.) igual se limpia lo local,
  /// para que el usuario nunca quede trabado sin poder cerrar sesion.
  static Future<void> logout() async {
    try {
      final auth = await AuthService.signInAnonymously();
      final uid = auth['uid'] as String;
      final idToken = auth['idToken'] as String;
      await TripService.deleteMyTrips();
      await http.delete(Uri.parse('${AppConfig.firebaseDbUrl}/passengers/$uid.json?auth=$idToken'));
      await _deleteCredentialPhoto(uid, idToken);
    } catch (_) {
      // Se ignora: el borrado local de abajo debe pasar siempre.
    }

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('registered');
    await prefs.remove('passenger_name');
    await prefs.remove('passenger_phone');
    await prefs.remove('active_trip_id');
    await prefs.remove('uid');
    await prefs.remove('idToken');
    await prefs.remove('refreshToken');
    await prefs.remove('expiresAt');
  }

  static Future<void> _deleteCredentialPhoto(String uid, String idToken) async {
    final path = 'passenger_credentials/$uid/credential.jpg';
    final encodedPath = Uri.encodeComponent(path);
    final uri = Uri.parse(
      'https://firebasestorage.googleapis.com/v0/b/${AppConfig.firebaseStorageBucket}/o/$encodedPath',
    );
    await http.delete(uri, headers: {'Authorization': 'Firebase $idToken'});
  }

  static Future<String> _uploadCredentialPhoto(
    String uid,
    String idToken,
    Uint8List photoBytes,
  ) async {
    final path = 'passenger_credentials/$uid/credential.jpg';
    final encodedPath = Uri.encodeComponent(path);
    final uploadUri = Uri.parse(
      'https://firebasestorage.googleapis.com/v0/b/${AppConfig.firebaseStorageBucket}/o'
      '?uploadType=media&name=$encodedPath',
    );

    final response = await http.post(
      uploadUri,
      headers: {
        'Authorization': 'Firebase $idToken',
        'Content-Type': 'image/jpeg',
      },
      body: photoBytes,
    );

    if (response.statusCode != 200) {
      throw Exception('No se pudo subir la foto (${response.statusCode}): ${response.body}');
    }

    final data = jsonDecode(response.body);
    final token = data['downloadTokens'];
    return 'https://firebasestorage.googleapis.com/v0/b/${AppConfig.firebaseStorageBucket}/o/$encodedPath?alt=media&token=$token';
  }
}
