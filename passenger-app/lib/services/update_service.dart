import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config.dart';

/// Consulta Firebase al abrir la app. Un fallo de red nunca bloquea al
/// pasajero: solo se exige actualizar cuando Firebase confirma un build mayor.
class UpdateService {
  static const _cachedMinimumBuildKey = 'cached_passenger_minimum_build';
  static const _cachedDownloadUrlKey = 'cached_passenger_download_url';

  static bool requiresBuildUpdate({
    required int localBuild,
    int? remoteBuild,
    int? cachedBuild,
  }) {
    final requiredBuild = [
      remoteBuild ?? 0,
      cachedBuild ?? 0,
    ].reduce((a, b) => a > b ? a : b);
    return requiredBuild > localBuild;
  }

  static Future<bool> isUpdateRequired() async {
    final localNumber =
        int.tryParse((await PackageInfo.fromPlatform()).buildNumber) ?? 0;
    final prefs = await SharedPreferences.getInstance();
    final cachedBuild = prefs.getInt(_cachedMinimumBuildKey);
    int? remoteNumber;
    try {
      final uri = AppConfig.useVpsBackend
          ? Uri.parse('${AppConfig.vpsApiBaseUrl}/api/v1/public/config')
          : Uri.parse(
              '${AppConfig.firebaseDbUrl}/config/${AppConfig.updateBuildConfigKey}.json',
            );
      final response = await http
          .get(uri)
          .timeout(const Duration(seconds: 8));
      if (response.statusCode != 200) {
        return requiresBuildUpdate(
          localBuild: localNumber,
          cachedBuild: cachedBuild,
        );
      }

      final raw = jsonDecode(response.body);
      final remoteBuild = AppConfig.useVpsBackend && raw is Map
          ? raw[AppConfig.updateBuildConfigKey]
          : raw;
      remoteNumber = remoteBuild is num
          ? remoteBuild.toInt()
          : int.tryParse('$remoteBuild');
      if (remoteNumber != null && remoteNumber > (cachedBuild ?? 0)) {
        await prefs.setInt(_cachedMinimumBuildKey, remoteNumber);
      }
      if (AppConfig.useVpsBackend && raw is Map && raw['passengerApkUrl'] is String) {
        await prefs.setString(_cachedDownloadUrlKey, raw['passengerApkUrl'] as String);
      }
    } catch (_) {
      // La última política confirmada sigue aplicando aun sin conexión.
    }
    return requiresBuildUpdate(
      localBuild: localNumber,
      remoteBuild: remoteNumber,
      cachedBuild: cachedBuild,
    );
  }

  static Future<void> downloadUpdate() async {
    final prefs = await SharedPreferences.getInstance();
    final url = prefs.getString(_cachedDownloadUrlKey) ?? AppConfig.apkDownloadUrl;
    await launchUrl(
      Uri.parse('$url${url.contains('?') ? '&' : '?'}v=${DateTime.now().millisecondsSinceEpoch}'),
      mode: LaunchMode.externalApplication,
    );
  }
}
