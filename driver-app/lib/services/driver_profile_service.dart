import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import '../config.dart';
import 'auth_service.dart';

/// Un documento ya elegido (foto o PDF) listo para subir a Storage.
class PickedDocument {
  final Uint8List bytes;
  final String extension; // 'jpg' o 'pdf'
  final String contentType; // 'image/jpeg' o 'application/pdf'

  PickedDocument({
    required this.bytes,
    required this.extension,
    required this.contentType,
  });
}

/// Reemplaza a IdentityService: perfil + documentos del conductor viven en
/// `drivers/{uid}` (ya no hay un nodo `driver_identities` separado). Sube
/// los documentos a Storage con el mismo patron REST que ya usa
/// passenger-app (passenger_service.dart -> _uploadCredentialPhoto), pero
/// aceptando imagen o PDF segun el `contentType` de cada archivo.
class DriverProfileService {
  static const _docFieldToUrlField = {
    'profile': 'profilePhotoUrl',
    'dni': 'dniDocUrl',
    'license': 'licenseDocUrl',
    'soat': 'soatDocUrl',
    'circulationCard': 'circulationCardDocUrl',
    'technicalReview': 'technicalReviewDocUrl',
    'criminalRecord': 'criminalRecordDocUrl',
    'workCertificate': 'workCertificateDocUrl',
  };

  static Future<Map<String, dynamic>?> fetchProfile(String uid) async {
    final auth = await AuthService.currentSession();
    final uri = Uri.parse(
      '${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=${auth['idToken']}',
    );
    final response = await http.get(uri);
    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la consulta (${response.statusCode}): ${response.body}');
    }
    final data = jsonDecode(response.body);
    return data == null ? null : Map<String, dynamic>.from(data);
  }

  /// Registro inicial: crea la cuenta, sube los documentos y escribe el
  /// nodo `drivers/{uid}` completo con `approvalStatus: 'pending_review'`.
  static Future<void> registerDriver({
    required String email,
    required String password,
    required String name,
    required int age,
    required String phone,
    required String dni,
    required String plate,
    required Map<String, PickedDocument> documents,
  }) async {
    final auth = await AuthService.registerWithEmail(email: email, password: password);
    final uid = auth['uid'] as String;
    final idToken = auth['idToken'] as String;

    final validation = await http.post(
      Uri.parse('https://us-central1-rastreoflota-53052.cloudfunctions.net/reserveDriverIdentity'),
      headers: {'Authorization': 'Bearer $idToken', 'Content-Type': 'application/json'},
      body: jsonEncode({'name': name, 'dni': dni, 'plate': plate}),
    );
    if (validation.statusCode != 200) {
      final response = jsonDecode(validation.body);
      throw Exception(response is Map ? response['error'] ?? 'No se pudo validar el registro.' : 'No se pudo validar el registro.');
    }

    final docUrls = await _uploadAll(uid, idToken, documents);
    final now = DateTime.now().millisecondsSinceEpoch;

    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=$idToken');
    final response = await http.put(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'email': email,
        'name': name,
        'age': age,
        'phone': phone,
        'dni': dni,
        'plate': plate,
        ...docUrls,
        'approvalStatus': 'pending_review',
        'registeredAt': now,
        'documentsSubmittedAt': now,
      }),
    );

    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo el registro (${response.statusCode}): ${response.body}');
    }
  }

  /// Re-envio tras un rechazo: solo sube los documentos que el conductor
  /// volvio a elegir y regresa el estado a `pending_review`, sin tocar
  /// nombre/telefono/DNI/placa.
  static Future<void> resubmitDocuments(Map<String, PickedDocument> documents) async {
    final auth = await AuthService.currentSession();
    final uid = auth['uid'] as String;
    final idToken = auth['idToken'] as String;

    final docUrls = await _uploadAll(uid, idToken, documents);

    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=$idToken');
    final response = await http.patch(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        ...docUrls,
        'approvalStatus': 'pending_review',
        'documentsSubmittedAt': DateTime.now().millisecondsSinceEpoch,
      }),
    );

    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la actualizacion (${response.statusCode}): ${response.body}');
    }
  }

  /// Reclama esta sesion como la unica activa para la cuenta: se llama
  /// justo despues de un login/registro exitoso (nunca en un reinicio en
  /// frio con sesion ya guardada) para que, si otro telefono tenia la
  /// sesion abierta con la misma cuenta, el suyo detecte el cambio de
  /// `activeSessionId` y se cierre solo (ver main.dart
  /// `_checkSessionStillActive`).
  static Future<void> claimSession(String sessionId) async {
    final auth = await AuthService.currentSession();
    final uid = auth['uid'] as String;
    final idToken = auth['idToken'] as String;

    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=$idToken');
    final response = await http.patch(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'activeSessionId': sessionId}),
    );

    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la sesion (${response.statusCode}): ${response.body}');
    }
  }

  /// El conductor solo puede editar su telefono despues de aprobado (mismo
  /// criterio que la version anterior): nombre/edad/DNI/placa/documentos
  /// requieren contactar a soporte o una resubida formal.
  static Future<void> updatePhone(String phone) async {
    final auth = await AuthService.currentSession();
    final uid = auth['uid'] as String;
    final idToken = auth['idToken'] as String;

    final uri = Uri.parse('${AppConfig.firebaseDbUrl}/drivers/$uid.json?auth=$idToken');
    final response = await http.patch(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'phone': phone}),
    );

    if (response.statusCode != 200) {
      throw Exception('Firebase rechazo la actualizacion (${response.statusCode}): ${response.body}');
    }
  }

  static Future<Map<String, String>> _uploadAll(
    String uid,
    String idToken,
    Map<String, PickedDocument> documents,
  ) async {
    final result = <String, String>{};
    for (final entry in documents.entries) {
      final urlField = _docFieldToUrlField[entry.key];
      if (urlField == null) continue;
      result[urlField] = await _uploadDocument(uid, idToken, entry.key, entry.value);
    }
    return result;
  }

  static Future<String> _uploadDocument(
    String uid,
    String idToken,
    String docKey,
    PickedDocument file,
  ) async {
    final path = 'driver_documents/$uid/$docKey.${file.extension}';
    final encodedPath = Uri.encodeComponent(path);
    final uploadUri = Uri.parse(
      'https://firebasestorage.googleapis.com/v0/b/${AppConfig.firebaseStorageBucket}/o'
      '?uploadType=media&name=$encodedPath',
    );

    final response = await http.post(
      uploadUri,
      headers: {
        'Authorization': 'Firebase $idToken',
        'Content-Type': file.contentType,
      },
      body: file.bytes,
    );

    if (response.statusCode != 200) {
      throw Exception('No se pudo subir "$docKey" (${response.statusCode}): ${response.body}');
    }

    final data = jsonDecode(response.body);
    final token = data['downloadTokens'];
    return 'https://firebasestorage.googleapis.com/v0/b/${AppConfig.firebaseStorageBucket}/o/$encodedPath?alt=media&token=$token';
  }
}
