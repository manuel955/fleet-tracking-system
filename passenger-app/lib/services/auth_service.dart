import 'dart:convert';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';

/// Mantiene compatibilidad con las sesiones anónimas existentes y añade
/// recuperación por teléfono para las cuentas nuevas o actualizadas.
class AuthService {
  static FirebaseAuth get _firebaseAuth => FirebaseAuth.instance;

  static Future<Map<String, dynamic>> signInAnonymously() async {
    try {
      final firebaseUser = _firebaseAuth.currentUser;
      if (firebaseUser != null && !firebaseUser.isAnonymous) {
        final token = await firebaseUser.getIdToken();
        return {'uid': firebaseUser.uid, 'idToken': token};
      }
    } catch (_) {
      // En web o antes de inicializar Firebase se usa la sesión REST anterior.
    }

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

  static bool get hasPhoneSession {
    try {
      final user = _firebaseAuth.currentUser;
      return user != null && !user.isAnonymous;
    } catch (_) {
      return false;
    }
  }

  static Future<Map<String, dynamic>> signInWithEmailPassword({
    required String email,
    required String password,
  }) async {
    final result = await _firebaseAuth.signInWithEmailAndPassword(
      email: email.trim(),
      password: password,
    );
    final user = result.user;
    if (user == null) {
      throw Exception('Firebase no devolvio la cuenta de pasajero.');
    }
    final idToken = await user.getIdToken();
    if (idToken == null || idToken.isEmpty) {
      throw Exception('No se pudo obtener la sesion del pasajero.');
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('uid', user.uid);
    await prefs.setString('idToken', idToken);
    await prefs.setInt(
      'expiresAt',
      DateTime.now().millisecondsSinceEpoch + 50 * 60 * 1000,
    );
    await prefs.remove('refreshToken');
    return {'uid': user.uid, 'idToken': idToken};
  }

  static Future<void> sendPhoneCode({
    required String phoneNumber,
    required void Function(String verificationId, int? resendToken) onCodeSent,
    required void Function(FirebaseAuthException error) onVerificationFailed,
    required void Function(PhoneAuthCredential credential)
    onVerificationCompleted,
  }) async {
    await _firebaseAuth.verifyPhoneNumber(
      phoneNumber: phoneNumber,
      verificationCompleted: onVerificationCompleted,
      verificationFailed: onVerificationFailed,
      codeSent: onCodeSent,
      codeAutoRetrievalTimeout: (_) {},
      timeout: const Duration(seconds: 60),
    );
  }

  static Future<Map<String, dynamic>> finishPhoneCode({
    required String verificationId,
    required String code,
  }) async {
    final credential = PhoneAuthProvider.credential(
      verificationId: verificationId,
      smsCode: code,
    );
    return finishPhoneCredential(credential);
  }

  static Future<Map<String, dynamic>> finishPhoneCredential(
    PhoneAuthCredential credential,
  ) async {
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

    final result = await _firebaseAuth.signInWithCredential(credential);
    final user = result.user;
    if (user == null) {
      throw Exception('Firebase no devolvió la cuenta telefónica.');
    }
    final idToken = await user.getIdToken();
    if (idToken == null || idToken.isEmpty) {
      throw Exception('No se pudo obtener la sesión telefónica.');
    }

    if (oldIdToken != null && oldIdToken.isNotEmpty) {
      final migration = await http.post(
        Uri.parse('${AppConfig.cloudFunctionsBaseUrl}/migratePassengerAccount'),
        headers: {
          'Authorization': 'Bearer $idToken',
          'Content-Type': 'application/json',
        },
        body: jsonEncode({'oldIdToken': oldIdToken}),
      );
      if (migration.statusCode != 200) {
        await _firebaseAuth.signOut();
        final body = jsonDecode(migration.body.isEmpty ? '{}' : migration.body);
        throw Exception(
          body is Map
              ? body['error'] ?? 'No se pudo recuperar la cuenta.'
              : 'No se pudo recuperar la cuenta.',
        );
      }
    }

    await prefs.setString('uid', user.uid);
    await prefs.setString('idToken', idToken);
    await prefs.setInt(
      'expiresAt',
      DateTime.now().millisecondsSinceEpoch + 50 * 60 * 1000,
    );
    await prefs.remove('refreshToken');
    return {'uid': user.uid, 'idToken': idToken};
  }

  static Future<void> deleteCurrentAccount() async {
    final session = await signInAnonymously();
    final response = await http.post(
      Uri.parse('${AppConfig.cloudFunctionsBaseUrl}/deleteMyAccount'),
      headers: {
        'Authorization': 'Bearer ${session['idToken']}',
        'Content-Type': 'application/json',
      },
    );
    if (response.statusCode != 200) {
      final body = jsonDecode(response.body);
      final message = body is Map ? body['error'] : null;
      throw Exception(message?.toString() ?? 'No se pudo eliminar la cuenta.');
    }
    await clearLocalSession();
  }

  static Future<void> clearLocalSession() async {
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
    await prefs.remove('active_trip_id');
    await prefs.remove('scheduled_trip_id');
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
}
