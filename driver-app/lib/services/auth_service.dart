import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';
import 'secure_session_store.dart';
import 'vps_api_client.dart';

/// Autenticacion con correo/contraseña contra Firebase Auth via REST (mismo
/// estilo REST-manual que el resto de la app: RTDB y Storage tampoco usan
/// SDKs). El uid resultante se usa como driverId, lo que hace que las reglas
/// de seguridad `auth.uid === $driverId` se cumplan automaticamente.
class AuthService {
  static const _networkTimeout = Duration(seconds: 15);

  static Future<Map<String, dynamic>> registerOrResumeWithEmail({
    required String email,
    required String password,
  }) async {
    if (AppConfig.useVpsBackend) {
      throw Exception(
        'El alta de conductores en VPS requiere completar placa y telefono; usa el registro Firebase mientras terminamos esa pantalla.',
      );
    }
    final uri = Uri.parse(
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${AppConfig.firebaseApiKey}',
    );
    final response = await http
        .post(
          uri,
          body: jsonEncode({
            'email': email,
            'password': password,
            'returnSecureToken': true,
          }),
        )
        .timeout(_networkTimeout);

    if (response.statusCode != 200 && response.body.contains('EMAIL_EXISTS')) {
      // La cuenta puede haberse creado antes de que terminara la subida de
      // documentos. Con las mismas credenciales se retoma el mismo UID.
      return signInWithEmail(email: email, password: password);
    }
    if (response.statusCode != 200) {
      throw Exception(friendlyError(response.body));
    }

    final data = jsonDecode(response.body);
    await _persist(data);
    return {'uid': data['localId'], 'idToken': data['idToken']};
  }

  static Future<Map<String, dynamic>> signInWithEmail({
    required String email,
    required String password,
  }) async {
    if (AppConfig.useVpsBackend) {
      final data = await VpsApiClient.login(email: email, password: password);
      final user = data['user'];
      final token = data['token']?.toString();
      final uid = user is Map ? user['id']?.toString() : null;
      if (token == null || token.isEmpty || uid == null || uid.isEmpty) {
        throw Exception('El API VPS no devolvio una sesion valida.');
      }
      await _persistVps(uid: uid, token: token);
      return {'uid': uid, 'idToken': token};
    }
    final uri = Uri.parse(
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${AppConfig.firebaseApiKey}',
    );
    final response = await http
        .post(
          uri,
          body: jsonEncode({
            'email': email,
            'password': password,
            'returnSecureToken': true,
          }),
        )
        .timeout(_networkTimeout);

    if (response.statusCode != 200) {
      throw Exception(friendlyError(response.body));
    }

    final data = jsonDecode(response.body);
    await _persist(data);
    return {'uid': data['localId'], 'idToken': data['idToken']};
  }

  static Future<bool> isLoggedIn() async {
    final session = await SecureSessionStore.read();
    final expiresAt = session['expiresAt'] as int? ?? 0;
    return session['uid'] != null &&
        session['idToken'] != null &&
        DateTime.now().millisecondsSinceEpoch < expiresAt;
  }

  static Future<void> sendPasswordResetEmail(String email) async {
    if (AppConfig.useVpsBackend) {
      throw Exception(
        'El recupero de contrasena del VPS aun no esta habilitado; usa Firebase en esta version.',
      );
    }
    final normalizedEmail = email.trim();
    if (normalizedEmail.isEmpty || !normalizedEmail.contains('@')) {
      throw Exception('Escribe un correo valido.');
    }
    final response = await http
        .post(
          Uri.parse(
            'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${AppConfig.firebaseApiKey}',
          ),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'requestType': 'PASSWORD_RESET',
            'email': normalizedEmail,
          }),
        )
        .timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(friendlyError(response.body));
    }
  }

  /// Sesion actual (cacheada o refrescada). A diferencia de la version
  /// anterior (auth anonima), esta NO crea una cuenta nueva si no hay
  /// sesion -- solo se debe llamar despues de un login/registro exitoso.
  static Future<Map<String, dynamic>> currentSession() async {
    final session = await SecureSessionStore.read();
    final cachedUid = session['uid'] as String?;
    final cachedToken = session['idToken'] as String?;
    final expiresAt = session['expiresAt'] as int? ?? 0;

    if (cachedUid != null &&
        cachedToken != null &&
        DateTime.now().millisecondsSinceEpoch < expiresAt) {
      return {'uid': cachedUid, 'idToken': cachedToken};
    }

    final refreshToken = session['refreshToken'] as String?;
    if (refreshToken != null) {
      final refreshed = await _refresh(refreshToken);
      if (refreshed != null) return refreshed;
    }

    throw Exception('No hay sesión activa: inicia sesión de nuevo.');
  }

  static Future<void> logout() async {
    await SecureSessionStore.clear();
  }

  static Future<void> deleteCurrentAccount() async {
    if (AppConfig.useVpsBackend) {
      throw Exception('La eliminacion de cuentas VPS aun no esta habilitada.');
    }
    final session = await currentSession();
    final response = await http.post(
      Uri.parse('${AppConfig.cloudFunctionsBaseUrl}/deleteMyAccount'),
      headers: {
        'Authorization': 'Bearer ${session['idToken']}',
        'Content-Type': 'application/json',
      },
    ).timeout(_networkTimeout);
    if (response.statusCode != 200) {
      final body = jsonDecode(response.body);
      final message = body is Map ? body['error'] : null;
      throw Exception(message?.toString() ?? 'No se pudo eliminar la cuenta.');
    }
    await logout();
  }

  static Future<Map<String, dynamic>?> _refresh(String refreshToken) async {
    final uri = Uri.parse(
      'https://securetoken.googleapis.com/v1/token?key=${AppConfig.firebaseApiKey}',
    );
    final response = await http.post(
      uri,
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: {'grant_type': 'refresh_token', 'refresh_token': refreshToken},
    ).timeout(_networkTimeout);

    if (response.statusCode != 200) return null;

    final data = jsonDecode(response.body);
    final expiresAt = DateTime.now().millisecondsSinceEpoch +
        (int.parse(data['expires_in']) * 1000) -
        60000;
    await SecureSessionStore.write(
      uid: data['user_id'],
      idToken: data['id_token'],
      refreshToken: data['refresh_token'],
      expiresAt: expiresAt,
    );
    return {'uid': data['user_id'], 'idToken': data['id_token']};
  }

  static Future<void> _persist(Map<String, dynamic> data) async {
    await SecureSessionStore.write(
      uid: data['localId'],
      idToken: data['idToken'],
      refreshToken: data['refreshToken'],
      expiresAt: DateTime.now().millisecondsSinceEpoch +
          (int.parse(data['expiresIn']) * 1000) -
          60000,
    );
  }

  static Future<void> _persistVps({
    required String uid,
    required String token,
  }) async {
    await SecureSessionStore.write(
      uid: uid,
      idToken: token,
      expiresAt:
          DateTime.now().millisecondsSinceEpoch + 6 * 24 * 60 * 60 * 1000,
    );
  }

  /// Traduce el codigo de error crudo de la API REST de Identity Toolkit
  /// (ej. "EMAIL_EXISTS", "WEAK_PASSWORD : ...") a un mensaje legible,
  /// mismo criterio que dashboard/js/app.js usa para los codigos `auth/*`
  /// de la SDK JS (los codigos difieren porque aqui se habla REST directo).
  static String friendlyError(String responseBody) {
    const messages = {
      'EMAIL_EXISTS':
          'Ya existe una cuenta con ese correo y la contraseña no coincide.',
      'EMAIL_NOT_FOUND': 'Credenciales inválidas o usuario no existe.',
      'INVALID_PASSWORD': 'Credenciales inválidas o usuario no existe.',
      'INVALID_LOGIN_CREDENTIALS':
          'Credenciales inválidas o usuario no existe.',
      'INVALID_EMAIL': 'Correo inválido.',
      'WEAK_PASSWORD': 'La contraseña debe tener al menos 6 caracteres.',
    };
    for (final entry in messages.entries) {
      if (responseBody.contains(entry.key)) return entry.value;
    }
    return 'Ocurrió un error. Intenta de nuevo.';
  }
}
