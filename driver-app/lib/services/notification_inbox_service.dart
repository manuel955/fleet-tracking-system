import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Bandeja local de avisos importantes del conductor. Se guarda por UID para
/// que una cuenta no vea avisos de otra si se cambia de usuario en el mismo
/// telefono.
class NotificationInboxService {
  static const _keyPrefix = 'driver_notification_inbox_';
  static const _lastUidKey = 'driver_notification_last_uid';

  static Future<SharedPreferences> _prefs() => SharedPreferences.getInstance();

  static Future<String> _key(SharedPreferences prefs) async =>
      '$_keyPrefix${prefs.getString('uid') ?? prefs.getString(_lastUidKey) ?? 'unknown'}';

  static Future<void> rememberDriverUid(String uid) async {
    if (uid.isEmpty) return;
    final prefs = await _prefs();
    await prefs.setString(_lastUidKey, uid);
  }

  static Future<List<Map<String, dynamic>>> read() async {
    final prefs = await _prefs();
    final raw = prefs.getString(await _key(prefs));
    if (raw == null || raw.isEmpty) return [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return [];
      return decoded
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList();
    } catch (_) {
      return [];
    }
  }

  static Future<int> unreadCount() async {
    final items = await read();
    return items.where((item) => item['read'] != true).length;
  }

  static Future<void> markAllRead() async {
    final prefs = await _prefs();
    final key = await _key(prefs);
    final items = await read();
    await prefs.setString(
      key,
      jsonEncode(items.map((item) => {...item, 'read': true}).toList()),
    );
  }

  static Future<void> recordApproval({
    required String status,
    String reason = '',
    String rejectionFieldKeys = '',
    String reviewedAt = '',
  }) async {
    if (status != 'approved' && status != 'rejected') return;

    final prefs = await _prefs();
    final key = await _key(prefs);
    final items = await read();
    final uniquePart = reviewedAt.isNotEmpty
        ? reviewedAt
        : '$status|$reason|$rejectionFieldKeys';
    final id = 'approval:$status:$uniquePart';
    final index = items.indexWhere((item) => item['id'] == id);
    final previous = index >= 0 ? items[index] : null;
    final item = <String, dynamic>{
      'id': id,
      'type': 'approval_status',
      'status': status,
      'title':
          status == 'approved' ? 'Registro aprobado' : 'Registro rechazado',
      'body': status == 'approved'
          ? 'Tu registro fue aprobado. Ya puedes iniciar tu turno.'
          : (reason.isNotEmpty
              ? reason
              : 'Revisa tus documentos y vuelve a enviarlos.'),
      'rejectionReason': reason,
      'rejectionFieldKeys': rejectionFieldKeys,
      'createdAt':
          int.tryParse(reviewedAt) ?? DateTime.now().millisecondsSinceEpoch,
      'read': previous?['read'] == true,
    };

    if (index >= 0) {
      items[index] = item;
    } else {
      items.insert(0, item);
    }
    if (items.length > 50) items.removeRange(50, items.length);
    await prefs.setString(key, jsonEncode(items));
  }
}
