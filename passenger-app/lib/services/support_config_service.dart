import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';

/// Numero de soporte editable desde el dashboard (config/supportPhone,
/// lectura publica -- ver database/firebase-rules.json). Sin cache: cada
/// llamada trae el valor vigente, para que un cambio en el dashboard se
/// refleje sin tener que reabrir la app. Si Firebase no responde, cae al
/// numero fijo de AppConfig.supportPhone. Mismo servicio que
/// driver-app/lib/services/support_config_service.dart.
class SupportConfigService {
  static Future<String> fetchSupportPhone() async {
    try {
      final uri = Uri.parse(
        '${AppConfig.firebaseDbUrl}/config/supportPhone.json',
      );
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
