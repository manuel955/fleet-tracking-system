import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config.dart';

/// Consulta Firebase al abrir la app. Un fallo de red nunca bloquea al
/// pasajero: solo se exige actualizar cuando Firebase confirma un build mayor.
class UpdateService {
  static Future<bool> isUpdateRequired() async {
    try {
      final response = await http
          .get(
            Uri.parse(
              '${AppConfig.firebaseDbUrl}/config/${AppConfig.updateBuildConfigKey}.json',
            ),
          )
          .timeout(const Duration(seconds: 8));
      if (response.statusCode != 200) return false;

      final remoteBuild = jsonDecode(response.body);
      final remoteNumber = remoteBuild is num
          ? remoteBuild.toInt()
          : int.tryParse('$remoteBuild');
      final localNumber =
          int.tryParse((await PackageInfo.fromPlatform()).buildNumber) ?? 0;
      return remoteNumber != null && remoteNumber > localNumber;
    } catch (_) {
      return false;
    }
  }

  static Future<void> downloadUpdate() => launchUrl(
    Uri.parse(
      '${AppConfig.apkDownloadUrl}&v=${DateTime.now().millisecondsSinceEpoch}',
    ),
    mode: LaunchMode.externalApplication,
  );
}
