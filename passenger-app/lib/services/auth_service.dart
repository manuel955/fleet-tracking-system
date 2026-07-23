import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';

/// Autenticacion anonima contra Firebase Auth via REST.
/// El uid resultante se usa como passengerId, lo que hace que las reglas
/// de seguridad `auth.uid === $passengerId` se cumplan automaticamente.
class AuthService {
  static Future<Map<String, dynamic>> signInAnonymously() async {
    final prefs = await SharedPreferences.getInstance();

    final cachedUid = prefs.getString('uid');
    final cachedToken = prefs.getString('idToken');
    final expiresAt = prefs.getInt('expiresAt') ?? 0;

    if (cachedUid != null &&
        cachedToken != null &&
        DateTime.now().millisecondsSinceEpoch < expiresAt) {
      return {'uid': cachedUid, 'idToken': cachedToken};
    }

    final refreshToken = prefs.getString('refreshToken');
    if (refreshToken != null) {
      final refreshed = await _refresh(refreshToken);
      if (refreshed != null) return refreshed;
    }

    final uri = Uri.parse(
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${AppConfig.firebaseApiKey}',
    );
    final response = await http.post(
      uri,
      body: jsonEncode({'returnSecureToken': true}),
    );

    if (response.statusCode != 200) {
      throw Exception('No se pudo autenticar: ${response.body}');
    }

    final data = jsonDecode(response.body);
    await _persist(prefs, data);
    return {'uid': data['localId'], 'idToken': data['idToken']};
  }

  static Future<Map<String, dynamic>?> _refresh(String refreshToken) async {
    final uri = Uri.parse(
      'https://securetoken.googleapis.com/v1/token?key=${AppConfig.firebaseApiKey}',
    );
    final response = await http.post(
      uri,
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: {'grant_type': 'refresh_token', 'refresh_token': refreshToken},
    );

    if (response.statusCode != 200) return null;

    final data = jsonDecode(response.body);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('idToken', data['id_token']);
    await prefs.setString('refreshToken', data['refresh_token']);
    await prefs.setInt(
      'expiresAt',
      DateTime.now().millisecondsSinceEpoch +
          (int.parse(data['expires_in']) * 1000) -
          60000,
    );
    return {'uid': data['user_id'], 'idToken': data['id_token']};
  }

  static Future<void> _persist(
    SharedPreferences prefs,
    Map<String, dynamic> data,
  ) async {
    await prefs.setString('uid', data['localId']);
    await prefs.setString('idToken', data['idToken']);
    await prefs.setString('refreshToken', data['refreshToken']);
    await prefs.setInt(
      'expiresAt',
      DateTime.now().millisecondsSinceEpoch +
          (int.parse(data['expiresIn']) * 1000) -
          60000,
    );
  }
}
