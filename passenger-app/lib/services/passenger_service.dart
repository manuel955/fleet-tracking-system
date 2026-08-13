import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import 'auth_service.dart';
import 'vps_api_client.dart';
import 'push_service.dart';

/// Registro del pasajero: nombre, telefono y una foto de su credencial
/// (DNI/carnet). A diferencia de la app del conductor, esta foto NO se usa
/// para reconocimiento facial -- solo se guarda como referencia. El
/// registro se hace una sola vez; no se vuelve a pedir en aperturas
/// posteriores de la app (el flag "registered" si se persiste en disco).
class PassengerService {
  static const _networkTimeout = Duration(seconds: 15);
  static const _uploadTimeout = Duration(seconds: 60);
  static const _accessGrantedKey = 'passenger_access_granted';
  static const _accessHotelNameKey = 'passenger_access_hotel_name';
  static const _accessExpiresAtKey = 'passenger_access_expires_at';
  static const _accessLegacyKey = 'passenger_access_legacy';

  static Future<bool> isRegistered() async {
    if (AppConfig.useVpsBackend && AuthService.hasEmailSession) return true;
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool('registered') ?? false;
  }

  static Future<bool> hasAccess() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_accessGrantedKey) != true) return false;
    if (prefs.getBool(_accessLegacyKey) == true) return true;
    final expiresAt = prefs.getInt(_accessExpiresAtKey) ?? 0;
    if (expiresAt > DateTime.now().millisecondsSinceEpoch) return true;
    await clearCachedAccess();
    return false;
  }

  static Future<Map<String, dynamic>> redeemInvite(String code) async {
    if (AppConfig.useVpsBackend) {
      final result = await VpsApiClient.redeemPassengerInvite(code);
      final user = result['user'];
      final token = result['token']?.toString();
      final uid = user is Map ? user['id']?.toString() : null;
      if (token == null || token.isEmpty || uid == null || uid.isEmpty) {
        throw Exception(
          'El API VPS no devolvió una sesión de invitado válida.',
        );
      }
      await AuthService.adoptVpsSession(
        uid: uid,
        token: token,
        email: user is Map ? user['email']?.toString() : null,
        displayName: user is Map ? user['displayName']?.toString() : null,
      );
      final access = result['access'];
      if (access is! Map) {
        throw Exception('El VPS no devolvió el acceso del huésped.');
      }
      final normalizedAccess = Map<String, dynamic>.from(access);
      await _persistAccess(normalizedAccess);
      return normalizedAccess;
    }
    final auth = await AuthService.signInAnonymously();
    final response = await http
        .post(
          Uri.parse('${AppConfig.cloudFunctionsBaseUrl}/redeemPassengerInvite'),
          headers: {
            'Authorization': 'Bearer ${auth['idToken']}',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({'code': code}),
        )
        .timeout(_networkTimeout);
    final body = decodeResponseBody(response.body);
    if (body == null) {
      throw Exception(
        'El servicio de acceso no respondió correctamente. Intenta de nuevo en unos minutos.',
      );
    }
    if (response.statusCode != 200) {
      throw Exception(
        body is Map ? body['error'] ?? 'Código no válido' : 'Código no válido',
      );
    }
    if (body is! Map || body['access'] is! Map) {
      throw Exception('Respuesta inválida del servicio de acceso.');
    }
    final access = Map<String, dynamic>.from(body['access'] as Map);
    await _persistAccess(access);
    return access;
  }

  /// Migra silenciosamente una cuenta antigua ya registrada. Las cuentas
  /// nuevas no pueden usar este camino: el servidor exige un perfil creado
  /// antes del corte de la migración.
  static Future<bool> ensureAccess() async {
    if (AppConfig.useVpsBackend) {
      final session = await AuthService.signInAnonymously();
      final result = await VpsApiClient.me(session['idToken']!.toString());
      final user = result['user'];
      if (user is! Map || user['role']?.toString() != 'passenger') {
        await clearCachedAccess();
        return false;
      }
      final status = user['passengerAccessStatus']?.toString();
      final expiresAt = (user['passengerAccessExpiresAt'] as num?)?.toInt();
      if (status != 'authorized' ||
          (expiresAt != null &&
              expiresAt <= DateTime.now().millisecondsSinceEpoch)) {
        await clearCachedAccess();
        return false;
      }
      await _persistAccess({
        'status': 'authorized',
        'legacy': expiresAt == null,
        'expiresAt': ?expiresAt,
      });
      return true;
    }
    final auth = await AuthService.signInAnonymously();
    final response = await http
        .post(
          Uri.parse('${AppConfig.cloudFunctionsBaseUrl}/ensurePassengerAccess'),
          headers: {
            'Authorization': 'Bearer ${auth['idToken']}',
            'Content-Type': 'application/json',
          },
          body: '{}',
        )
        .timeout(_networkTimeout);
    if (response.statusCode != 200) {
      if (response.statusCode == 401 || response.statusCode == 403) {
        await clearCachedAccess();
        return false;
      }
      throw Exception(
        'El servicio de acceso no está disponible temporalmente.',
      );
    }
    final body = decodeResponseBody(response.body);
    if (body is! Map || body['access'] is! Map) {
      throw Exception('El servicio de acceso devolvió una respuesta inválida.');
    }
    final access = Map<String, dynamic>.from(body['access'] as Map);
    await _persistAccess(access);
    return true;
  }

  /// Decodifica respuestas JSON del backend sin propagar errores de formato
  /// cuando una pasarela devuelve HTML u otro contenido no esperado.
  static dynamic decodeResponseBody(String raw) {
    final normalized = raw.trim();
    if (normalized.isEmpty) return <String, dynamic>{};
    try {
      return jsonDecode(normalized);
    } on FormatException {
      return null;
    }
  }

  static Future<Map<String, String>?> cachedProfile() async {
    final prefs = await SharedPreferences.getInstance();
    final name = prefs.getString('passenger_name');
    final phone = prefs.getString('passenger_phone');
    if (name == null || phone == null) return null;
    final photoUrl = prefs.getString('passenger_photo_url');
    return {
      'name': name,
      'phone': phone,
      if (photoUrl != null && photoUrl.isNotEmpty) 'photoUrl': photoUrl,
    };
  }

  /// Refresca el perfil remoto para que una cuenta existente tambien pueda
  /// compartir su foto en el siguiente viaje.
  static Future<Map<String, String>?> loadProfile() async {
    if (AppConfig.useVpsBackend && AuthService.hasEmailSession) {
      final prefs = await SharedPreferences.getInstance();
      try {
        final auth = await AuthService.currentSession();
        final profile = await VpsApiClient.getPassengerProfile(
          token: auth['idToken'].toString(),
        );
        final name = profile['name']?.toString().trim().isNotEmpty == true
            ? profile['name'].toString().trim()
            : (AuthService.currentDisplayName?.trim().isNotEmpty == true
                  ? AuthService.currentDisplayName!.trim()
                  : 'Pasajero');
        final phone = profile['phone']?.toString() ?? '';
        final photoUrl = profile['photoUrl']?.toString() ?? '';
        await prefs.setBool('registered', true);
        await prefs.setString('passenger_name', name);
        await prefs.setString('passenger_phone', phone);
        if (photoUrl.isNotEmpty) {
          await prefs.setString('passenger_photo_url', photoUrl);
        }
        return {
          'name': name,
          'phone': phone,
          if (photoUrl.isNotEmpty) 'photoUrl': photoUrl,
        };
      } catch (_) {
        final name = AuthService.currentDisplayName?.trim().isNotEmpty == true
            ? AuthService.currentDisplayName!.trim()
            : 'Pasajero';
        final phone = prefs.getString('passenger_phone') ?? '';
        return {'name': name, 'phone': phone};
      }
    }
    final cached = await cachedProfile();
    try {
      final auth = await AuthService.signInAnonymously();
      final response = await http
          .get(
            Uri.parse(
              '${AppConfig.firebaseDbUrl}/passengers/${auth['uid']}.json?auth=${auth['idToken']}',
            ),
          )
          .timeout(_networkTimeout);
      if (response.statusCode == 200 && response.body != 'null') {
        final data = Map<String, dynamic>.from(jsonDecode(response.body));
        final remoteName = data['name']?.toString().trim();
        final remotePhone = data['phone']?.toString().trim();
        final remotePhoto = data['credentialPhotoUrl']?.toString().trim();
        if (remoteName != null &&
            remoteName.isNotEmpty &&
            remotePhone != null) {
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString('passenger_name', remoteName);
          await prefs.setString('passenger_phone', remotePhone);
          if (remotePhoto != null && remotePhoto.isNotEmpty) {
            await prefs.setString('passenger_photo_url', remotePhoto);
          }
          return {
            'name': remoteName,
            'phone': remotePhone,
            if (remotePhoto != null && remotePhoto.isNotEmpty)
              'photoUrl': remotePhoto,
          };
        }
      }
    } catch (_) {
      // La copia local permite continuar si hay una falla puntual de red.
    }
    return cached;
  }

  static Future<void> registerPassenger({
    required String name,
    required String phone,
    required Uint8List photoBytes,
  }) async {
    final auth = AppConfig.useVpsBackend
        ? await AuthService.currentSession()
        : await AuthService.signInAnonymously();
    final uid = auth['uid'] as String;
    final idToken = auth['idToken'] as String;

    final photoUrl = await _uploadCredentialPhoto(uid, idToken, photoBytes);

    if (AppConfig.useVpsBackend) {
      final profile = await VpsApiClient.savePassengerProfile(
        token: idToken,
        name: name,
        phone: phone,
        credentialPhotoUrl: photoUrl,
      );
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool('registered', true);
      await prefs.setString(
        'passenger_name',
        profile['name']?.toString() ?? name,
      );
      await prefs.setString(
        'passenger_phone',
        profile['phone']?.toString() ?? phone,
      );
      await prefs.setString(
        'passenger_photo_url',
        profile['photoUrl']?.toString() ?? photoUrl,
      );
      return;
    }
    final response = await http
        .post(
          Uri.parse(
            '${AppConfig.cloudFunctionsBaseUrl}/registerPassengerProfile',
          ),
          headers: {
            'Authorization': 'Bearer $idToken',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            'name': name,
            'phone': phone,
            'credentialPhotoUrl': photoUrl,
          }),
        )
        .timeout(_networkTimeout);

    if (response.statusCode != 200) {
      final body = jsonDecode(response.body.isEmpty ? '{}' : response.body);
      throw Exception(
        'Firebase rechazo el registro (${response.statusCode}): ${body is Map ? body['error'] ?? response.body : response.body}',
      );
    }

    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('registered', true);
    await prefs.setString('passenger_name', name);
    await prefs.setString('passenger_phone', phone);
    await prefs.setString('passenger_photo_url', photoUrl);
  }

  static Future<void> logout() async {
    await PushService.unregisterCurrentToken();
    await AuthService.clearLocalSession();
  }

  static Future<void> deleteAccount() async {
    await AuthService.deleteCurrentAccount();
  }

  static Future<void> _persistAccess(Map<String, dynamic> access) async {
    final prefs = await SharedPreferences.getInstance();
    final authorized = access['status'] == 'authorized';
    if (!authorized) {
      await clearCachedAccess();
      return;
    }
    await prefs.setBool(_accessGrantedKey, true);
    await prefs.setBool(_accessLegacyKey, access['legacy'] == true);
    final hotelName = access['hotelName']?.toString();
    if (hotelName != null && hotelName.isNotEmpty) {
      await prefs.setString(_accessHotelNameKey, hotelName);
    }
    final expiresAt = int.tryParse(access['expiresAt']?.toString() ?? '');
    if (expiresAt != null) {
      await prefs.setInt(_accessExpiresAtKey, expiresAt);
    } else {
      await prefs.remove(_accessExpiresAtKey);
    }
  }

  static Future<void> clearCachedAccess() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_accessGrantedKey);
    await prefs.remove(_accessHotelNameKey);
    await prefs.remove(_accessExpiresAtKey);
    await prefs.remove(_accessLegacyKey);
  }

  static Future<String> _uploadCredentialPhoto(
    String uid,
    String idToken,
    Uint8List photoBytes,
  ) async {
    final path = 'passenger_credentials/$uid/credential.jpg';
    if (AppConfig.useVpsBackend) {
      final result = await VpsApiClient.uploadStorage(
        token: idToken,
        key: path,
        contentType: 'image/jpeg',
        bytes: photoBytes,
      );
      final url = result['url']?.toString();
      if (url == null || url.isEmpty) {
        throw Exception('El API VPS no devolvio la URL de la credencial.');
      }
      return url;
    }
    final encodedPath = Uri.encodeComponent(path);
    final uploadUri = Uri.parse(
      'https://firebasestorage.googleapis.com/v0/b/${AppConfig.firebaseStorageBucket}/o'
      '?uploadType=media&name=$encodedPath',
    );

    final response = await http
        .post(
          uploadUri,
          headers: {
            'Authorization': 'Firebase $idToken',
            'Content-Type': 'image/jpeg',
          },
          body: photoBytes,
        )
        .timeout(_uploadTimeout);

    if (response.statusCode != 200) {
      throw Exception(
        'No se pudo subir la foto (${response.statusCode}): ${response.body}',
      );
    }

    final data = jsonDecode(response.body);
    final token = data['downloadTokens'];
    return 'https://firebasestorage.googleapis.com/v0/b/${AppConfig.firebaseStorageBucket}/o/$encodedPath?alt=media&token=$token';
  }
}
