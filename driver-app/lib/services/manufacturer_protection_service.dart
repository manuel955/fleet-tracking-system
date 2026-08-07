import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

class ManufacturerProtectionInfo {
  const ManufacturerProtectionInfo({
    required this.key,
    required this.brand,
    required this.model,
    required this.steps,
    required this.reason,
  });

  final String key;
  final String brand;
  final String model;
  final List<String> steps;
  final String reason;
}

/// Android permite que cada fabricante suspenda una app aunque exista un
/// foreground service. Esta guia lleva al conductor a los ajustes que el
/// sistema del fabricante usa para decidir si conserva la app activa.
class ManufacturerProtectionService {
  static const _shownKeyPrefix = 'manufacturer_protection_seen_v2_';

  static Future<ManufacturerProtectionInfo> detect() async {
    if (!Platform.isAndroid) {
      return const ManufacturerProtectionInfo(
        key: 'generic',
        brand: 'Android',
        model: '',
        reason:
            'Mantener la app activa permite enviar el GPS durante todo el turno.',
        steps: [
          'Permite la ubicacion en segundo plano y las notificaciones.',
          'En Bateria, configura APL Logistics como Sin restricciones.',
        ],
      );
    }

    final info = await DeviceInfoPlugin().androidInfo;
    final maker = '${info.manufacturer} ${info.brand}'.toLowerCase();
    final model = info.model.trim();

    if (maker.contains('huawei') || maker.contains('honor')) {
      return ManufacturerProtectionInfo(
        key: 'huawei',
        brand: maker.contains('honor') ? 'HONOR' : 'Huawei',
        model: model,
        reason:
            'EMUI puede detener el GPS cuando la pantalla se apaga, aunque el turno siga activo.',
        steps: const [
          'Ajustes > Aplicaciones > Inicio de aplicaciones > APL Logistics.',
          'Desactiva Gestionar automaticamente y activa Inicio automatico, Inicio secundario y Ejecutar en segundo plano.',
          'Ajustes > Bateria > Optimizacion de bateria > Todas las aplicaciones > APL Logistics > No permitir.',
          'Abre Aplicaciones recientes y bloquea APL Logistics con el candado.',
          'Si aparece, activa Bateria > Mas ajustes > Mantener conectado cuando el dispositivo entre en suspension.',
        ],
      );
    }

    if (maker.contains('xiaomi') ||
        maker.contains('redmi') ||
        maker.contains('poco')) {
      return ManufacturerProtectionInfo(
        key: 'xiaomi',
        brand: 'Xiaomi/Redmi/POCO',
        model: model,
        reason:
            'MIUI puede cerrar procesos en segundo plano para ahorrar bateria.',
        steps: const [
          'Ajustes > Aplicaciones > Permisos > Inicio automatico > activa APL Logistics.',
          'Ajustes > Bateria > APL Logistics > Sin restricciones.',
          'Abre Aplicaciones recientes y bloquea APL Logistics con el candado.',
          'Conserva activadas la ubicacion en segundo plano y las notificaciones.',
        ],
      );
    }

    if (maker.contains('oppo') ||
        maker.contains('realme') ||
        maker.contains('oneplus')) {
      return ManufacturerProtectionInfo(
        key: 'oppo_realme',
        brand: 'OPPO/realme/OnePlus',
        model: model,
        reason:
            'ColorOS puede limitar la actividad y el inicio automatico de la app.',
        steps: const [
          'Ajustes > Aplicaciones > Inicio automatico > activa APL Logistics.',
          'Ajustes > Bateria > Uso de bateria de la app > Sin restricciones.',
          'Permite actividad en segundo plano y notificaciones.',
          'No cierres APL Logistics desde Aplicaciones recientes durante el turno.',
        ],
      );
    }

    if (maker.contains('vivo') || maker.contains('iqoo')) {
      return ManufacturerProtectionInfo(
        key: 'vivo',
        brand: 'vivo/iQOO',
        model: model,
        reason:
            'Funtouch OS puede detener procesos de ubicacion en segundo plano.',
        steps: const [
          'Ajustes > Bateria > Gestion de bateria > Sin restricciones para APL Logistics.',
          'Activa el inicio automatico y la actividad en segundo plano.',
          'Permite las notificaciones y la ubicacion en segundo plano.',
          'No cierres APL Logistics desde Aplicaciones recientes durante el turno.',
        ],
      );
    }

    if (maker.contains('samsung')) {
      return ManufacturerProtectionInfo(
        key: 'samsung',
        brand: 'Samsung',
        model: model,
        reason:
            'One UI puede poner la app en suspension y cortar el servicio de ubicacion.',
        steps: const [
          'Ajustes > Bateria y cuidado del dispositivo > Bateria > Limites de uso en segundo plano.',
          'Quita APL Logistics de Aplicaciones en suspension y suspension profunda.',
          'Configura la bateria de APL Logistics como Sin restricciones.',
          'Permite la ubicacion en segundo plano y las notificaciones.',
        ],
      );
    }

    return ManufacturerProtectionInfo(
      key: 'generic',
      brand: info.brand,
      model: model,
      reason:
          'El fabricante puede limitar procesos en segundo plano cuando la pantalla se apaga.',
      steps: const [
        'Ajustes > Aplicaciones > APL Logistics > Bateria > Sin restricciones.',
        'Permite la ubicacion en segundo plano y las notificaciones.',
        'Si existe Inicio automatico, activa APL Logistics.',
        'No cierres APL Logistics desde Aplicaciones recientes durante el turno.',
      ],
    );
  }

  static Future<void> showIfNeeded(BuildContext context) async {
    final info = await detect();
    final prefs = await SharedPreferences.getInstance();
    final key = '$_shownKeyPrefix${info.key}';
    if (prefs.getBool(key) == true || !context.mounted) return;

    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => _ProtectionDialog(info: info),
    );
    await prefs.setBool(key, true);
  }
}

class _ProtectionDialog extends StatelessWidget {
  const _ProtectionDialog({required this.info});

  final ManufacturerProtectionInfo info;

  @override
  Widget build(BuildContext context) {
    final deviceLabel =
        info.model.isEmpty ? info.brand : '${info.brand} ${info.model}';

    return AlertDialog(
      title: const Text('Protege el GPS durante el turno'),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(deviceLabel,
                  style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text(info.reason),
              const SizedBox(height: 14),
              const Text('Configura estas opciones una sola vez:',
                  style: TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              for (var i = 0; i < info.steps.length; i++)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${i + 1}. ',
                          style: const TextStyle(fontWeight: FontWeight.w700)),
                      Expanded(child: Text(info.steps[i])),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () async {
            await openAppSettings();
          },
          child: const Text('Abrir ajustes de la app'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Continuar turno'),
        ),
      ],
    );
  }
}
