import 'dart:math';
import 'package:shared_preferences/shared_preferences.dart';

/// Identificador de "este dispositivo" para permitir una sola sesion activa
/// por conductor. Al iniciar sesion (login o registro) se genera uno nuevo
/// y se escribe en `drivers/{uid}/activeSessionId`; si otro telefono inicia
/// sesion despues con la misma cuenta, sobreescribe ese campo con el suyo, y
/// este dispositivo lo detecta comparando contra el id que guardo aqui (ver
/// main.dart `_checkSessionStillActive`) para cerrar su propia sesion sola.
class SessionService {
  static const _key = 'active_session_id';

  static Future<String> startNewSession() async {
    final id =
        '${DateTime.now().millisecondsSinceEpoch}-${Random().nextInt(1 << 31)}';
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, id);
    return id;
  }

  static Future<String?> localSessionId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_key);
  }

  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }
}
