import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import '../config.dart';
import 'auth_service.dart';
import 'vps_api_client.dart';

/// Un documento ya elegido (foto o PDF) listo para subir a Storage.
class PickedDocument {
  final Uint8List bytes;
  final String extension; // 'jpg' o 'pdf'
  final String contentType; // 'image/jpeg' o 'application/pdf'
  final String? displayName;

  PickedDocument({
    required this.bytes,
    required this.extension,
    required this.contentType,
    this.displayName,
  });
}

/// Reemplaza a IdentityService: perfil + documentos del conductor viven en
/// `drivers/{uid}` (ya no hay un nodo `driver_identities` separado). Sube
/// los documentos a Storage con el mismo patron REST que ya usa
/// passenger-app (passenger_service.dart -> _uploadCredentialPhoto), pero
/// aceptando imagen o PDF segun el `contentType` de cada archivo.
class DriverProfileService {
  static const _networkTimeout = Duration(seconds: 15);
  static const _uploadTimeout = Duration(seconds: 60);
  static const _docFieldToUrlField = {
    'profile': 'profilePhotoUrl',
    'license': 'licenseDocUrl',
    'soat': 'soatDocUrl',
    'circulationCard': 'circulationCardDocUrl',
    'technicalReview': 'technicalReviewDocUrl',
    'criminalRecord': 'criminalRecordDocUrl',
    'workCertificate': 'workCertificateDocUrl',
  };

  static Future<Map<String, dynamic>?> fetchProfile(String uid) async {
    final auth = await AuthService.currentSession();
    if (AppConfig.useVpsBackend) {
      final profile = await VpsApiClient.driverMe(auth['idToken'].toString());
      final availability =
          profile['availabilityStatus']?.toString() ?? 'offline';
      return {
        ...profile,
        'name': profile['name'] ?? 'Conductor',
        'age': profile['age'] ?? '',
        'vehicleBrand': profile['vehicleBrand'] ?? '',
        'vehicleColor': profile['vehicleColor'] ?? '',
        'status': availability,
        'turno_activo': availability == 'online',
        'suspended': profile['suspended'] == true,
      };
    }
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=${auth['idToken']}',
    );
    final response = await http.get(uri).timeout(_networkTimeout);
    if (response.statusCode != 200) {
      throw Exception(
          'Firebase rechazo la consulta (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
    return data == null ? null : Map<String, dynamic>.from(data);
  }

  /// Registro inicial reintentable: crea o recupera la misma cuenta, sube los
  /// documentos obligatorios y deja que Cloud Functions valide y escriba el
  /// perfil completo de forma privilegiada.
  static Future<void> registerDriver({
    required String email,
    required String password,
    required String name,
    required int age,
    required String phone,
    required String dni,
    required String plate,
    required String vehicleBrand,
    required String vehicleType,
    required String vehicleColor,
    required int vehicleSeats,
    required Map<String, List<PickedDocument>> documents,
    required Map<String, int> documentExpiries,
  }) async {
    final dniFiles = documents['dni'] ?? const <PickedDocument>[];
    if (!_isValidDniSelection(dniFiles)) {
      throw Exception('El DNI requiere 2 fotos o 1 solo PDF.');
    }

    const requiredDocuments = {
      'profile',
      'dni',
      'license',
      'soat',
      'circulationCard',
      'technicalReview',
      'criminalRecord',
      'workCertificate',
    };
    final missingDocuments = requiredDocuments
        .where((key) => (documents[key] ?? const <PickedDocument>[]).isEmpty)
        .toList();
    if (missingDocuments.isNotEmpty) {
      throw Exception('Todos los documentos son obligatorios.');
    }
    for (final key in const ['license', 'soat', 'technicalReview']) {
      final expiresAt = documentExpiries[key] ?? 0;
      if (expiresAt <= DateTime.now().millisecondsSinceEpoch) {
        throw Exception('Selecciona una fecha de vencimiento vigente.');
      }
    }

    final auth = await AuthService.registerOrResumeWithEmail(
      email: email,
      password: password,
      name: name,
      phone: phone,
      plate: plate,
      vehicleType: vehicleType,
      vehicleSeats: vehicleSeats,
    );
    final uid = auth['uid'] as String;
    final idToken = auth['idToken'] as String;

    final docUrls = await _uploadAll(uid, idToken, documents);
    final applicationBody = <String, dynamic>{
      'name': name,
      'age': age,
      'phone': phone,
      'dni': dni,
      'plate': plate,
      'vehicleBrand': vehicleBrand,
      'vehicleType': vehicleType,
      'vehicleColor': vehicleColor,
      'vehicleSeats': vehicleSeats,
      ...docUrls,
      'licenseExpiresAt': documentExpiries['license'],
      'soatExpiresAt': documentExpiries['soat'],
      'technicalReviewExpiresAt': documentExpiries['technicalReview'],
    };
    if (AppConfig.useVpsBackend) {
      await VpsApiClient.submitDriverApplication(
        token: idToken,
        body: applicationBody,
      );
      return;
    }
    final response = await http
        .post(
          Uri.parse(
              '${AppConfig.cloudFunctionsBaseUrl}/completeDriverRegistration'),
          headers: {
            'Authorization': 'Bearer $idToken',
            'Content-Type': 'application/json',
          },
          body: jsonEncode(applicationBody),
        )
        .timeout(_networkTimeout);

    if (response.statusCode != 200) {
      final data = jsonDecode(response.body);
      throw Exception(data is Map
          ? data['error'] ?? 'No se pudo completar el registro.'
          : 'No se pudo completar el registro.');
    }
  }

  /// Re-envio tras un rechazo: solo sube los documentos que el conductor
  /// volvio a elegir y regresa el estado a `pending_review`, sin tocar
  /// nombre/telefono/DNI/placa.
  static Future<void> resubmitDocuments(
    Map<String, List<PickedDocument>> documents, {
    required Map<String, int> documentExpiries,
    Map<String, dynamic> profileChanges = const {},
  }) async {
    if (documents.containsKey('dni') &&
        !_isValidDniSelection(documents['dni'] ?? const <PickedDocument>[])) {
      throw Exception('El DNI requiere 2 fotos o 1 solo PDF.');
    }

    final auth = await AuthService.currentSession();
    final uid = auth['uid'] as String;
    final idToken = auth['idToken'] as String;

    final docUrls = await _uploadAll(uid, idToken, documents);
    final expiryFields = <String, int>{};
    const expiryFieldByDocument = {
      'license': 'licenseExpiresAt',
      'soat': 'soatExpiresAt',
      'technicalReview': 'technicalReviewExpiresAt',
    };
    for (final entry in expiryFieldByDocument.entries) {
      if (!documents.containsKey(entry.key)) continue;
      final expiresAt = documentExpiries[entry.key] ?? 0;
      if (expiresAt <= DateTime.now().millisecondsSinceEpoch) {
        throw Exception('Selecciona una fecha de vencimiento vigente.');
      }
      expiryFields[entry.value] = expiresAt;
    }

    if (AppConfig.useVpsBackend) {
      await VpsApiClient.submitDriverApplication(
        token: idToken,
        body: {
          ...profileChanges,
          ...docUrls,
          ...expiryFields,
        },
      );
      return;
    }
    final response = await http
        .post(
          Uri.parse(
              '${AppConfig.cloudFunctionsBaseUrl}/resubmitDriverApplication'),
          headers: {
            'Authorization': 'Bearer $idToken',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            ...profileChanges,
            ...docUrls,
            ...expiryFields,
          }),
        )
        .timeout(_networkTimeout);

    if (response.statusCode != 200) {
      final data = jsonDecode(response.body);
      throw Exception(data is Map
          ? data['error'] ?? 'No se pudo reenviar el registro.'
          : 'No se pudo reenviar el registro.');
    }
  }

  /// Reclama esta sesion como la unica activa para la cuenta: se llama
  /// justo despues de un login/registro exitoso (nunca en un reinicio en
  /// frio con sesion ya guardada) para que, si otro telefono tenia la
  /// sesion abierta con la misma cuenta, el suyo detecte el cambio de
  /// `activeSessionId` y se cierre solo (ver main.dart
  /// `_checkSessionStillActive`).
  static Future<void> claimSession(String sessionId) async {
    if (AppConfig.useVpsBackend) return;
    final auth = await AuthService.currentSession();
    final uid = auth['uid'] as String;
    final idToken = auth['idToken'] as String;

    final uri =
        Uri.parse('${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=$idToken');
    final response = await http
        .patch(
          uri,
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'activeSessionId': sessionId}),
        )
        .timeout(_networkTimeout);

    if (response.statusCode != 200) {
      throw Exception(
          'Firebase rechazo la sesion (${response.statusCode}): ${response.body}');
    }
  }

  /// Permite corregir el telefono del conductor sin limite de veces. La
  /// validacion se hace en Cloud Functions y no depende solo de la interfaz.
  static Future<void> updatePhone({required String phone}) async {
    final auth = await AuthService.currentSession();
    final idToken = auth['idToken'] as String;

    final response = await http
        .post(
          Uri.parse(
              'https://us-central1-rastreoflota-53052.cloudfunctions.net/updateDriverProfileOnce'),
          headers: {
            'Authorization': 'Bearer $idToken',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            'phone': phone,
          }),
        )
        .timeout(_networkTimeout);

    if (response.statusCode != 200) {
      throw Exception(
          'Firebase rechazo la actualizacion (${response.statusCode}): ${response.body}');
    }
  }

  static Future<Map<String, String>> _uploadAll(
    String uid,
    String idToken,
    Map<String, List<PickedDocument>> documents,
  ) async {
    final result = <String, String>{};
    for (final entry in documents.entries) {
      final files = entry.value;
      if (files.isEmpty) continue;

      if (entry.key == 'dni') {
        if (files.length == 1 && files.single.extension == 'pdf') {
          result['dniDocUrl'] =
              await _uploadDocument(uid, idToken, 'dni', files.single);
        } else if (files.length == 2) {
          result['dniFrontDocUrl'] =
              await _uploadDocument(uid, idToken, 'dni_front', files[0]);
          result['dniBackDocUrl'] =
              await _uploadDocument(uid, idToken, 'dni_back', files[1]);
        }
        continue;
      }

      final urlField = _docFieldToUrlField[entry.key];
      if (urlField == null) continue;
      result[urlField] =
          await _uploadDocument(uid, idToken, entry.key, files.last);
    }
    return result;
  }

  static bool _isValidDniSelection(List<PickedDocument> files) {
    if (files.length == 1) return files.single.extension == 'pdf';
    return files.length == 2 && files.every((file) => file.extension != 'pdf');
  }

  static Future<String> _uploadDocument(
    String uid,
    String idToken,
    String docKey,
    PickedDocument file,
  ) async {
    final path = 'driver_documents/$uid/$docKey.${file.extension}';
    if (AppConfig.useVpsBackend) {
      final result = await VpsApiClient.uploadStorage(
        token: idToken,
        key: path,
        contentType: file.contentType,
        bytes: file.bytes,
      );
      final url = result['url']?.toString();
      if (url == null || url.isEmpty) {
        throw Exception('El API VPS no devolvio la URL del documento.');
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
            'Content-Type': file.contentType,
          },
          body: file.bytes,
        )
        .timeout(_uploadTimeout);

    if (response.statusCode != 200) {
      throw Exception(
          'No se pudo subir "$docKey" (${response.statusCode}): ${response.body}');
    }

    final data = jsonDecode(response.body);
    final token = data['downloadTokens'];
    return 'https://firebasestorage.googleapis.com/v0/b/${AppConfig.firebaseStorageBucket}/o/$encodedPath?alt=media&token=$token';
  }
}
