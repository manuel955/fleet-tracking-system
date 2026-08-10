import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SecureSessionStore {
  static const _storage = FlutterSecureStorage(aOptions: AndroidOptions());
  static const _uidKey = 'fleet_auth_uid';
  static const _idTokenKey = 'fleet_auth_id_token';
  static const _refreshTokenKey = 'fleet_auth_refresh_token';
  static const _expiresAtKey = 'fleet_auth_expires_at';

  static Future<void> _migrateLegacy() async {
    if (await _storage.read(key: _uidKey) != null) {
      await _removeLegacyValues();
      return;
    }
    final prefs = await SharedPreferences.getInstance();
    final uid = prefs.getString('uid');
    final idToken = prefs.getString('idToken');
    final refreshToken = prefs.getString('refreshToken');
    final expiresAt = prefs.getInt('expiresAt');
    if (uid != null) await _storage.write(key: _uidKey, value: uid);
    if (idToken != null) {
      await _storage.write(key: _idTokenKey, value: idToken);
    }
    if (refreshToken != null) {
      await _storage.write(key: _refreshTokenKey, value: refreshToken);
    }
    if (expiresAt != null) {
      await _storage.write(key: _expiresAtKey, value: expiresAt.toString());
    }
    await _removeLegacyValues(prefs);
  }

  static Future<Map<String, dynamic>> read() async {
    await _migrateLegacy();
    final values = await Future.wait([
      _storage.read(key: _uidKey),
      _storage.read(key: _idTokenKey),
      _storage.read(key: _refreshTokenKey),
      _storage.read(key: _expiresAtKey),
    ]);
    return {
      'uid': values[0],
      'idToken': values[1],
      'refreshToken': values[2],
      'expiresAt': int.tryParse(values[3] ?? '') ?? 0,
    };
  }

  static Future<void> write({
    required String uid,
    required String idToken,
    String? refreshToken,
    required int expiresAt,
  }) async {
    await _storage.write(key: _uidKey, value: uid);
    await _storage.write(key: _idTokenKey, value: idToken);
    if (refreshToken == null) {
      await _storage.delete(key: _refreshTokenKey);
    } else {
      await _storage.write(key: _refreshTokenKey, value: refreshToken);
    }
    await _storage.write(key: _expiresAtKey, value: expiresAt.toString());
    await _removeLegacyValues();
  }

  static Future<void> clear() async {
    await Future.wait([
      _storage.delete(key: _uidKey),
      _storage.delete(key: _idTokenKey),
      _storage.delete(key: _refreshTokenKey),
      _storage.delete(key: _expiresAtKey),
    ]);
    await _removeLegacyValues();
  }

  static Future<void> _removeLegacyValues([SharedPreferences? current]) async {
    final prefs = current ?? await SharedPreferences.getInstance();
    await Future.wait([
      prefs.remove('uid'),
      prefs.remove('idToken'),
      prefs.remove('refreshToken'),
      prefs.remove('expiresAt'),
    ]);
  }
}
