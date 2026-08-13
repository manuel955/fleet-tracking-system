import 'dart:convert';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import 'secure_session_store.dart';
import 'vps_api_client.dart';

/// Mantiene compatibilidad con las sesiones anónimas existentes y permite
/// recuperar la cuenta por correo y contraseña, sin autenticación por SMS.
class AuthService {
  static const _networkTimeout = Duration(seconds: 15);
  static FirebaseAuth get _firebaseAuth => FirebaseAuth.instance;
  static String? _vpsEmail;
  static String? _vpsDisplayName;

  static Future<void> initialize() async {
    if (!AppConfig.useVpsBackend) return;
    final prefs = await SharedPreferences.getInstance();
    final session = await SecureSessionStore.read();
    final expiresAt = session['expiresAt'] as int? ?? 0;
    if (DateTime.now().millisecondsSinceEpoch < expiresAt) {
      _vpsEmail = prefs.getString('vps_email');
      _vpsDisplayName = prefs.getString('vps_display_name');
    }
  }

  static Future<Map<String, dynamic>> signInAnonymously() async {
    if (AppConfig.useVpsBackend) {
      final session = await SecureSessionStore.read();
      final token = session['idToken'] as String?;
      final uid = session['uid'] as String?;
      final expiresAt = session['expiresAt'] as int? ?? 0;
      if (uid != null &&
          token != null &&
          DateTime.now().millisecondsSinceEpoch < expiresAt) {
        return {'uid': uid, 'idToken': token};
      }
      throw Exception('Inicia sesion con correo para usar el backend VPS.');
    }
    try {
      final firebaseUser = _firebaseAuth.currentUser;
      if (firebaseUser != null && !firebaseUser.isAnonymous) {
        final token = await firebaseUser.getIdToken().timeout(_networkTimeout);
        return {'uid': firebaseUser.uid, 'idToken': token};
      }
    } catch (_) {
      // En web o antes de inicializar Firebase se usa la sesión REST anterior.
    }

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

    final uri = Uri.parse(
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${AppConfig.firebaseApiKey}',
    );
    final response = await http
        .post(uri, body: jsonEncode({'returnSecureToken': true}))
        .timeout(_networkTimeout);

    if (response.statusCode != 200) {
      throw Exception('No se pudo autenticar: ${response.body}');
    }

    final data = jsonDecode(response.body);
    await _persist(data);
    return {'uid': data['localId'], 'idToken': data['idToken']};
  }

  static bool get hasEmailSession {
    if (AppConfig.useVpsBackend) return _vpsEmail?.isNotEmpty == true;
    try {
      final user = _firebaseAuth.currentUser;
      return user != null && (user.email?.trim().isNotEmpty ?? false);
    } catch (_) {
      return false;
    }
  }

  static String? get currentEmail {
    if (AppConfig.useVpsBackend) return _vpsEmail;
    try {
      final email = _firebaseAuth.currentUser?.email?.trim();
      return email == null || email.isEmpty ? null : email;
    } catch (_) {
      return null;
    }
  }

  /// Nombre devuelto por el API VPS para poder construir el perfil local del
  /// pasajero sin depender del antiguo registro anónimo de Firebase.
  static String? get currentDisplayName =>
      AppConfig.useVpsBackend ? _vpsDisplayName : null;

  static Future<Map<String, dynamic>> signInWithEmailPassword({
    required String email,
    required String password,
  }) async {
    if (AppConfig.useVpsBackend) {
      final data = await VpsApiClient.login(email: email, password: password);
      final user = data['user'];
      final token = data['token']?.toString();
      final uid = user is Map ? user['id']?.toString() : null;
      final displayName = user is Map ? user['displayName']?.toString() : null;
      if (token == null || token.isEmpty || uid == null || uid.isEmpty) {
        throw Exception('El API VPS no devolvio una sesion valida.');
      }
      await _persistVpsUser(
        uid: uid,
        token: token,
        email: email,
        displayName: displayName,
      );
      return {'uid': uid, 'idToken': token};
    }
    final result = await _firebaseAuth
        .signInWithEmailAndPassword(email: email.trim(), password: password)
        .timeout(_networkTimeout);
    final user = result.user;
    if (user == null) {
      throw Exception('Firebase no devolvio la cuenta de pasajero.');
    }
    return _persistFirebaseUser(user);
  }

  /// Devuelve la sesión persistida sin crear una cuenta nueva. En VPS se usa
  /// para operaciones autenticadas de perfil y documentos.
  static Future<Map<String, dynamic>> currentSession() async {
    final session = await SecureSessionStore.read();
    final uid = session['uid'] as String?;
    final token = session['idToken'] as String?;
    final expiresAt = session['expiresAt'] as int? ?? 0;
    if (uid != null &&
        token != null &&
        DateTime.now().millisecondsSinceEpoch < expiresAt) {
      return {'uid': uid, 'idToken': token};
    }
    return signInAnonymously();
  }

  /// Adopta la sesión temporal creada al canjear un QR del VPS. Se mantiene
  /// separado del login por correo para que el flujo de recepción no cree una
  /// cuenta Firebase ni requiera contraseña.
  static Future<void> adoptVpsSession({
    required String uid,
    required String token,
    String? email,
    String? displayName,
  }) async {
    await _persistVpsUser(
      uid: uid,
      token: token,
      email: email ?? 'guest-$uid@guest.apl.invalid',
      displayName: displayName,
    );
  }

  static Future<void> sendPasswordResetEmail(String email) async {
    if (AppConfig.useVpsBackend) {
      await VpsApiClient.requestPasswordReset(email: email);
      return;
    }
    await _firebaseAuth
        .sendPasswordResetEmail(email: email.trim())
        .timeout(_networkTimeout);
  }

  static Future<Map<String, dynamic>> linkWithEmailPassword({
    required String email,
    required String password,
  }) async {
    if (AppConfig.useVpsBackend) {
      final normalizedEmail = email.trim().toLowerCase();
      final session = await currentSession();
      final data = await VpsApiClient.linkPassengerEmail(
        token: session['idToken'].toString(),
        email: normalizedEmail,
        password: password,
      );
      final user = data['user'];
      final token = data['token']?.toString();
      final uid = user is Map ? user['id']?.toString() : null;
      if (token == null || token.isEmpty || uid == null || uid.isEmpty) {
        throw Exception('El API VPS no devolvio una sesion valida.');
      }
      await _persistVpsUser(
        uid: uid,
        token: token,
        email: normalizedEmail,
        displayName: user is Map ? user['displayName']?.toString() : null,
      );
      return {'uid': uid, 'idToken': token};
    }
    final normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.isEmpty || !normalizedEmail.contains('@')) {
      throw FirebaseAuthException(
        code: 'invalid-email',
        message: 'Escribe un correo válido.',
      );
    }
    if (password.length < 8) {
      throw FirebaseAuthException(
        code: 'weak-password',
        message: 'La contraseña debe tener al menos 8 caracteres.',
      );
    }

    final prefs = await SharedPreferences.getInstance();
    String? oldIdToken;
    final needsMigration =
        prefs.getBool('registered') == true ||
        prefs.getBool('passenger_access_granted') == true;
    if (needsMigration) {
      try {
        oldIdToken = (await signInAnonymously())['idToken']?.toString();
      } catch (_) {
        oldIdToken = null;
      }
    }

    final current = _firebaseAuth.currentUser;
    if (current?.email?.trim().isNotEmpty == true) {
      return _persistFirebaseUser(current!);
    }

    final credential = EmailAuthProvider.credential(
      email: normalizedEmail,
      password: password,
    );
    UserCredential result;
    var createdSeparateAccount = false;
    if (current != null) {
      result = await current
          .linkWithCredential(credential)
          .timeout(_networkTimeout);
    } else {
      result = await _firebaseAuth
          .createUserWithEmailAndPassword(
            email: normalizedEmail,
            password: password,
          )
          .timeout(_networkTimeout);
      createdSeparateAccount = true;
    }
    final user = result.user;
    if (user == null) {
      throw Exception('Firebase no devolvió la cuenta de correo.');
    }
    final idToken = await user.getIdToken().timeout(_networkTimeout);
    if (idToken == null || idToken.isEmpty) {
      throw Exception('No se pudo obtener la sesión de correo.');
    }

    if (oldIdToken != null && oldIdToken.isNotEmpty) {
      final migration = await http
          .post(
            Uri.parse(
              '${AppConfig.cloudFunctionsBaseUrl}/migratePassengerAccount',
            ),
            headers: {
              'Authorization': 'Bearer $idToken',
              'Content-Type': 'application/json',
            },
            body: jsonEncode({'oldIdToken': oldIdToken}),
          )
          .timeout(_networkTimeout);
      if (migration.statusCode != 200) {
        if (createdSeparateAccount) {
          await user.delete().catchError((_) {});
        }
        await _firebaseAuth.signOut();
        final body = jsonDecode(migration.body.isEmpty ? '{}' : migration.body);
        throw Exception(
          body is Map
              ? body['error'] ?? 'No se pudo recuperar la cuenta.'
              : 'No se pudo recuperar la cuenta.',
        );
      }
    }

    return _persistFirebaseUser(user, idToken: idToken);
  }

  static Future<Map<String, dynamic>> _persistFirebaseUser(
    User user, {
    String? idToken,
  }) async {
    final token = idToken ?? await user.getIdToken().timeout(_networkTimeout);
    if (token == null || token.isEmpty) {
      throw Exception('No se pudo obtener la sesión del pasajero.');
    }
    await SecureSessionStore.write(
      uid: user.uid,
      idToken: token,
      expiresAt: DateTime.now().millisecondsSinceEpoch + 50 * 60 * 1000,
    );
    return {'uid': user.uid, 'idToken': token};
  }

  static Future<void> _persistVpsUser({
    required String uid,
    required String token,
    required String email,
    String? displayName,
  }) async {
    _vpsEmail = email.trim().toLowerCase();
    _vpsDisplayName = displayName?.trim().isNotEmpty == true
        ? displayName!.trim()
        : 'Pasajero';
    await SecureSessionStore.write(
      uid: uid,
      idToken: token,
      expiresAt:
          DateTime.now().millisecondsSinceEpoch + 6 * 24 * 60 * 60 * 1000,
    );
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('vps_email', _vpsEmail!);
    await prefs.setString('vps_display_name', _vpsDisplayName!);
  }

  static Future<void> deleteCurrentAccount() async {
    if (AppConfig.useVpsBackend) {
      final session = await currentSession();
      await VpsApiClient.deleteAccount(token: session['idToken'].toString());
      await clearLocalSession();
      return;
    }
    final session = await currentSession();
    final response = await http
        .post(
          Uri.parse('${AppConfig.cloudFunctionsBaseUrl}/deleteMyAccount'),
          headers: {
            'Authorization': 'Bearer ${session['idToken']}',
            'Content-Type': 'application/json',
          },
        )
        .timeout(_networkTimeout);
    if (response.statusCode != 200) {
      final body = jsonDecode(response.body);
      final message = body is Map ? body['error'] : null;
      throw Exception(message?.toString() ?? 'No se pudo eliminar la cuenta.');
    }
    await clearLocalSession();
  }

  static Future<void> clearLocalSession() async {
    _vpsEmail = null;
    _vpsDisplayName = null;
    try {
      await _firebaseAuth.signOut();
    } catch (_) {}
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('registered');
    await prefs.remove('passenger_name');
    await prefs.remove('passenger_phone');
    await prefs.remove('passenger_photo_url');
    await prefs.remove('passenger_access_granted');
    await prefs.remove('passenger_access_hotel_name');
    await prefs.remove('passenger_access_expires_at');
    await prefs.remove('passenger_access_legacy');
    await prefs.remove('active_trip_id');
    await prefs.remove('vps_email');
    await prefs.remove('vps_display_name');
    await prefs.remove('scheduled_trip_id');
    for (final key in prefs.getKeys().where(
      (key) => key.startsWith('cached_trip_'),
    )) {
      await prefs.remove(key);
    }
    await SecureSessionStore.clear();
  }

  static Future<Map<String, dynamic>?> _refresh(String refreshToken) async {
    final uri = Uri.parse(
      'https://securetoken.googleapis.com/v1/token?key=${AppConfig.firebaseApiKey}',
    );
    final response = await http
        .post(
          uri,
          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: {'grant_type': 'refresh_token', 'refresh_token': refreshToken},
        )
        .timeout(_networkTimeout);

    if (response.statusCode != 200) return null;

    final data = jsonDecode(response.body);
    final expiresAt =
        DateTime.now().millisecondsSinceEpoch +
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
      expiresAt:
          DateTime.now().millisecondsSinceEpoch +
          (int.parse(data['expiresIn']) * 1000) -
          60000,
    );
  }
}
