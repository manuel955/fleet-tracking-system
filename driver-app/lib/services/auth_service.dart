import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';

/// Autenticacion con correo/contraseña contra Firebase Auth via REST (mismo
/// estilo REST-manual que el resto de la app: RTDB y Storage tampoco usan
/// SDKs). El uid resultante se usa como driverId, lo que hace que las reglas
/// de seguridad `auth.uid === $driverId` se cumplan automaticamente.
class AuthService {
  static Future<Map<String, dynamic>> registerWithEmail({
    required String email,
    required String password,
  }) async {
    final uri = Uri.parse(
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${AppConfig.firebaseApiKey}',
    );
    final response = await http.post(
      uri,
      body: jsonEncode({
        'email': email,
        'password': password,
        'returnSecureToken': true,
      }),
    );

    if (response.statusCode != 200) {
      throw Exception(friendlyError(response.body));
    }

    final data = jsonDecode(response.body);
    final prefs = await SharedPreferences.getInstance();
    await _persist(prefs, data);
    return {'uid': data['localId'], 'idToken': data['idToken']};
  }

  static Future<Map<String, dynamic>> signInWithEmail({
    required String email,
    required String password,
  }) async {
    final uri = Uri.parse(
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${AppConfig.firebaseApiKey}',
    );
    final response = await http.post(
      uri,
      body: jsonEncode({
        'email': email,
        'password': password,
        'returnSecureToken': true,
      }),
    );

    if (response.statusCode != 200) {
      throw Exception(friendlyError(response.body));
    }

    final data = jsonDecode(response.body);
    final prefs = await SharedPreferences.getInstance();
    await _persist(prefs, data);
    return {'uid': data['localId'], 'idToken': data['idToken']};
  }

  static Future<bool> isLoggedIn() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('uid') != null && prefs.getString('refreshToken') != null;
  }

  /// Sesion actual (cacheada o refrescada). A diferencia de la version
  /// anterior (auth anonima), esta NO crea una cuenta nueva si no hay
  /// sesion -- solo se debe llamar despues de un login/registro exitoso.
  static Future<Map<String, dynamic>> currentSession() async {
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

    throw Exception('No hay sesión activa: inicia sesión de nuevo.');
  }

  static Future<void> logout() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('uid');
    await prefs.remove('idToken');
    await prefs.remove('refreshToken');
    await prefs.remove('expiresAt');
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

  /// Traduce el codigo de error crudo de la API REST de Identity Toolkit
  /// (ej. "EMAIL_EXISTS", "WEAK_PASSWORD : ...") a un mensaje legible,
  /// mismo criterio que dashboard/js/app.js usa para los codigos `auth/*`
  /// de la SDK JS (los codigos difieren porque aqui se habla REST directo).
  static String friendlyError(String responseBody) {
    const messages = {
      'EMAIL_EXISTS': 'Ya existe una cuenta con ese correo. Inicia sesión en vez de registrarte.',
      'EMAIL_NOT_FOUND': 'Credenciales inválidas o usuario no existe.',
      'INVALID_PASSWORD': 'Credenciales inválidas o usuario no existe.',
      'INVALID_LOGIN_CREDENTIALS': 'Credenciales inválidas o usuario no existe.',
      'INVALID_EMAIL': 'Correo inválido.',
      'WEAK_PASSWORD': 'La contraseña debe tener al menos 6 caracteres.',
    };
    for (final entry in messages.entries) {
      if (responseBody.contains(entry.key)) return entry.value;
    }
    return 'Ocurrió un error. Intenta de nuevo.';
  }
}
