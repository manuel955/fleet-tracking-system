import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';

/// Numero de soporte editable desde el dashboard (config/supportPhone,
/// lectura publica -- ver database/firebase-rules.json). Sin cache: cada
/// llamada trae el valor vigente, para que un cambio en el dashboard se
/// refleje sin tener que reabrir la app. Si Firebase no responde, cae al
/// numero fijo de AppConfig.supportPhone.
class SupportConfigService {
  static Future<String> fetchSupportPhone() async {
    try {
      if (AppConfig.useVpsBackend) {
        final vpsResponse = await http
            .get(Uri.parse('${AppConfig.vpsApiBaseUrl}/api/v1/public/config'))
            .timeout(const Duration(seconds: 5));
        if (vpsResponse.statusCode == 200) {
          final payload = jsonDecode(vpsResponse.body);
          final value = payload is Map ? payload['supportPhone'] : null;
          if (value is String && value.isNotEmpty) return value;
        }
      }
      final uri =
          Uri.parse('${AppConfig.firebaseDbUrl}/config/supportPhone.json');
      final response = await http.get(uri).timeout(const Duration(seconds: 5));
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data is String && data.isNotEmpty) return data;
      }
    } catch (_) {
      // Sin red o Firebase caido: se usa el numero por defecto de AppConfig.
    }
    return AppConfig.supportPhone;
  }
}
