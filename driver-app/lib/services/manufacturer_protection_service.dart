import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum ProtectionCheckKind { platform, manual }

class ManufacturerProtectionRequirement {
  const ManufacturerProtectionRequirement({
    required this.id,
    required this.title,
    required this.description,
    required this.steps,
    required this.kind,
    this.route = 'app_details',
    this.component,
  });

  final String id;
  final String title;
  final String description;
  final List<String> steps;
  final ProtectionCheckKind kind;
  final String route;
  final String? component;
}

class ManufacturerProtectionInfo {
  const ManufacturerProtectionInfo({
    required this.key,
    required this.brand,
    required this.model,
    required this.requirements,
    required this.reason,
  });

  final String key;
  final String brand;
  final String model;
  final List<ManufacturerProtectionRequirement> requirements;
  final String reason;
}

class ManufacturerProtectionService {
  static const _confirmedKeyPrefix = 'manufacturer_protection_confirmed_v3_';
  static const _channel = MethodChannel('apl.tucompras/settings');

  static const _location = ManufacturerProtectionRequirement(
    id: 'location',
    title: 'Ubicación todo el tiempo',
    description:
        'Permite enviar el GPS durante el turno aunque la app esté minimizada o la pantalla apagada.',
    steps: [
      'Abre Permisos de APL Logistics.',
      'En Ubicación selecciona Permitir todo el tiempo y activa Ubicación precisa.',
    ],
    kind: ProtectionCheckKind.platform,
    route: 'permissions',
  );

  static const _notifications = ManufacturerProtectionRequirement(
    id: 'notifications',
    title: 'Notificaciones',
    description:
        'Necesarias para avisar de una asignación aunque estés viendo otra aplicación.',
    steps: [
      'Abre las notificaciones de APL Logistics.',
      'Activa Permitir notificaciones y las alertas de asignaciones.',
    ],
    kind: ProtectionCheckKind.platform,
    route: 'notifications',
  );

  static const _battery = ManufacturerProtectionRequirement(
    id: 'battery',
    title: 'Batería sin restricciones',
    description:
        'Evita que Android suspenda el servicio de GPS y las notificaciones.',
    steps: [
      'Abre la optimización de batería de APL Logistics.',
      'Selecciona No optimizar o Sin restricciones.',
    ],
    kind: ProtectionCheckKind.platform,
    route: 'battery',
  );

  static Future<ManufacturerProtectionInfo> detect() async {
    if (!Platform.isAndroid) {
      return const ManufacturerProtectionInfo(
        key: 'generic',
        brand: 'Android',
        model: '',
        reason:
            'Mantener la app activa permite enviar el GPS durante todo el turno.',
        requirements: [_location, _notifications, _battery],
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
        reason: 'EMUI puede detener el GPS cuando la pantalla se apaga.',
        requirements: [
          _location,
          _notifications,
          _battery,
          const ManufacturerProtectionRequirement(
            id: 'autostart',
            title: 'Inicio automático y segundo plano',
            description:
                'Permite que APL Logistics se mantenga activa al minimizarla.',
            steps: [
              'Desactiva Gestionar automáticamente.',
              'Activa Inicio automático, Inicio secundario y Ejecutar en segundo plano.',
            ],
            kind: ProtectionCheckKind.manual,
            route: 'component',
            component:
                'com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity',
          ),
          const ManufacturerProtectionRequirement(
            id: 'recent_apps',
            title: 'Bloquear en aplicaciones recientes',
            description:
                'Evita que EMUI cierre la app al limpiar aplicaciones recientes.',
            steps: ['Abre recientes y pulsa el candado de APL Logistics.'],
            kind: ProtectionCheckKind.manual,
          ),
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
            'MIUI puede cerrar procesos en segundo plano para ahorrar batería.',
        requirements: [
          _location,
          _notifications,
          _battery,
          const ManufacturerProtectionRequirement(
            id: 'autostart',
            title: 'Inicio automático de MIUI',
            description:
                'Permite que la app se reactive y reciba viajes asignados.',
            steps: [
              'Se abrirá la pantalla Inicio automático de MIUI.',
              'Busca APL Conductor y activa su interruptor.',
            ],
            kind: ProtectionCheckKind.manual,
            route: 'autostart',
          ),
          const ManufacturerProtectionRequirement(
            id: 'recent_apps',
            title: 'Bloquear en aplicaciones recientes',
            description: 'Evita que MIUI cierre la app al limpiar memoria.',
            steps: ['Abre recientes y pulsa el candado de APL Logistics.'],
            kind: ProtectionCheckKind.manual,
          ),
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
            'ColorOS/OxygenOS puede limitar el inicio y la actividad en segundo plano.',
        requirements: [
          _location,
          _notifications,
          _battery,
          const ManufacturerProtectionRequirement(
            id: 'autostart',
            title: 'Inicio automático y segundo plano',
            description:
                'Permite que la app se mantenga activa durante el turno.',
            steps: [
              'Activa Inicio automático y actividad en segundo plano para APL Logistics.'
            ],
            kind: ProtectionCheckKind.manual,
          ),
        ],
      );
    }

    if (maker.contains('vivo') || maker.contains('iqoo')) {
      return ManufacturerProtectionInfo(
        key: 'vivo',
        brand: 'vivo/iQOO',
        model: model,
        reason:
            'Funtouch OS puede detener procesos de ubicación en segundo plano.',
        requirements: [
          _location,
          _notifications,
          _battery,
          const ManufacturerProtectionRequirement(
            id: 'autostart',
            title: 'Inicio automático y segundo plano',
            description: 'Permite que la app siga enviando GPS al minimizarla.',
            steps: [
              'Activa Inicio automático y actividad en segundo plano para APL Logistics.'
            ],
            kind: ProtectionCheckKind.manual,
          ),
        ],
      );
    }

    if (maker.contains('samsung')) {
      return ManufacturerProtectionInfo(
        key: 'samsung',
        brand: 'Samsung',
        model: model,
        reason:
            'One UI puede poner la app en suspensión y cortar el servicio de ubicación.',
        requirements: [
          _location,
          _notifications,
          _battery,
          const ManufacturerProtectionRequirement(
            id: 'background_limits',
            title: 'Quitar límites de segundo plano',
            description:
                'Quita APL Logistics de aplicaciones en suspensión y suspensión profunda.',
            steps: [
              'En Batería y cuidado del dispositivo > Batería > Límites de uso en segundo plano.',
              'Quita APL Logistics de las listas de suspensión.',
            ],
            kind: ProtectionCheckKind.manual,
          ),
        ],
      );
    }

    return ManufacturerProtectionInfo(
      key: 'generic',
      brand: info.brand,
      model: model,
      reason:
          'El fabricante puede limitar procesos en segundo plano cuando la pantalla se apaga.',
      requirements: [
        _location,
        _notifications,
        _battery,
        const ManufacturerProtectionRequirement(
          id: 'background',
          title: 'Actividad en segundo plano',
          description: 'Mantén APL Logistics activa durante todo el turno.',
          steps: [
            'En Aplicaciones > APL Logistics > Batería selecciona Sin restricciones.'
          ],
          kind: ProtectionCheckKind.manual,
        ),
      ],
    );
  }

  static Future<Map<String, bool>> check(
      ManufacturerProtectionInfo info) async {
    final values = <String, bool>{};
    values['location'] = (await Permission.locationAlways.status).isGranted;
    values['notifications'] = (await Permission.notification.status).isGranted;
    if (Platform.isAndroid) {
      values['battery'] =
          (await Permission.ignoreBatteryOptimizations.status).isGranted;
    } else {
      values['battery'] = true;
    }
    final prefs = await SharedPreferences.getInstance();
    for (final requirement in info.requirements
        .where((item) => item.kind == ProtectionCheckKind.manual)) {
      values[requirement.id] =
          prefs.getBool(_confirmationKey(info, requirement)) == true;
    }
    return values;
  }

  static String _confirmationKey(ManufacturerProtectionInfo info,
      ManufacturerProtectionRequirement requirement) {
    return '$_confirmedKeyPrefix${info.key}_${requirement.id}';
  }

  static Future<bool> openRequirement(ManufacturerProtectionInfo info,
      ManufacturerProtectionRequirement requirement) async {
    if (!Platform.isAndroid) return openAppSettings();
    try {
      final opened = await _channel.invokeMethod<bool>('openSettings', {
        'route': requirement.route,
        'component': requirement.component,
      });
      return opened == true;
    } on PlatformException {
      return openAppSettings();
    }
  }

  static Future<bool> showIfNeeded(BuildContext context) async {
    final info = await detect();
    if (!context.mounted) return false;
    final checks = await check(info);
    if (!context.mounted) return false;
    final complete = info.requirements.every((item) => checks[item.id] == true);
    if (complete) return true;
    final result = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _ProtectionChecklistDialog(info: info),
    );
    return result == true;
  }
}

class _ProtectionChecklistDialog extends StatefulWidget {
  const _ProtectionChecklistDialog({required this.info});

  final ManufacturerProtectionInfo info;

  @override
  State<_ProtectionChecklistDialog> createState() =>
      _ProtectionChecklistDialogState();
}

class _ProtectionChecklistDialogState extends State<_ProtectionChecklistDialog>
    with WidgetsBindingObserver {
  Map<String, bool> _checks = const {};
  bool _loading = true;
  String? _opening;
  bool _checking = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _refresh();
    }
  }

  Future<void> _refresh({bool announce = false}) async {
    if (_checking) return;
    if (mounted) setState(() => _checking = true);
    try {
      final checks = await ManufacturerProtectionService.check(widget.info);
      if (!mounted) return;
      setState(() {
        _checks = checks;
        _loading = false;
      });
      if (announce) {
        final missing = widget.info.requirements
            .where((item) => checks[item.id] != true)
            .map((item) => item.title)
            .toList();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(missing.isEmpty
                ? 'Todos los permisos verificables están listos.'
                : 'Aún falta: ${missing.join(', ')}.'),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  bool get _complete =>
      widget.info.requirements.every((item) => _checks[item.id] == true);

  Future<void> _open(ManufacturerProtectionRequirement requirement) async {
    if (_opening != null) return;
    setState(() => _opening = requirement.id);
    try {
      await ManufacturerProtectionService.openRequirement(
        widget.info,
        requirement,
      ).timeout(const Duration(seconds: 4), onTimeout: () => true);
      // El botón no puede quedarse bloqueado si el fabricante mantiene
      // suspendido el canal mientras muestra sus Ajustes.
      if (mounted) setState(() => _opening = null);
      // Al volver de Ajustes, el sistema puede necesitar un instante para
      // persistir el permiso. Se vuelve a consultar en vez de asumir éxito.
    } catch (_) {
    } finally {
      if (mounted) setState(() => _opening = null);
    }
    // Un firmware OEM puede devolver false aunque ya haya cambiado a Ajustes;
    // no mostramos un error engañoso. El estado se revisa al volver a la app.
  }

  Future<void> _confirmManual(
      ManufacturerProtectionRequirement requirement) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(
        'manufacturer_protection_confirmed_v3_${widget.info.key}_${requirement.id}',
        true);
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final deviceLabel = widget.info.model.isEmpty
        ? widget.info.brand
        : '${widget.info.brand} ${widget.info.model}';
    return AlertDialog(
      title: const Text('Configura tu teléfono'),
      content: SizedBox(
        width: 520,
        height: 540,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                children: [
                  Text(deviceLabel,
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 6),
                  Text(widget.info.reason),
                  const SizedBox(height: 14),
                  ...widget.info.requirements.map(_requirementCard),
                  const SizedBox(height: 4),
                  const Text(
                    'Los ajustes del fabricante no siempre se pueden leer desde Android. Después de activarlos, pulsa “Ya lo activé” para dejar constancia y vuelve a verificar.',
                    style: TextStyle(fontSize: 12, color: Colors.black54),
                  ),
                ],
              ),
      ),
      actions: [
        TextButton(
          onPressed: _checking ? null : () => _refresh(announce: true),
          child: _checking
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Verificar permisos'),
        ),
        FilledButton(
          onPressed: _complete ? () => Navigator.of(context).pop(true) : null,
          child: const Text('Continuar turno'),
        ),
      ],
    );
  }

  Widget _requirementCard(ManufacturerProtectionRequirement requirement) {
    final done = _checks[requirement.id] == true;
    final opening = _opening == requirement.id;
    return Card(
      margin: const EdgeInsets.only(bottom: 9),
      child: Padding(
        padding: const EdgeInsets.all(11),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(done ? Icons.check_circle : Icons.error_outline,
                color: done ? Colors.green : Colors.orange.shade800),
            const SizedBox(width: 8),
            Expanded(
                child: Text(requirement.title,
                    style: const TextStyle(fontWeight: FontWeight.w700))),
            Text(done ? 'Listo' : 'Pendiente',
                style: TextStyle(
                    color:
                        done ? Colors.green.shade700 : Colors.orange.shade800,
                    fontSize: 12,
                    fontWeight: FontWeight.w600)),
          ]),
          const SizedBox(height: 5),
          Text(requirement.description, style: const TextStyle(fontSize: 12.5)),
          const SizedBox(height: 4),
          ...requirement.steps.map((step) => Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text('• $step', style: const TextStyle(fontSize: 12)),
              )),
          const SizedBox(height: 7),
          Wrap(spacing: 8, runSpacing: 6, children: [
            OutlinedButton.icon(
              onPressed: opening ? null : () => _open(requirement),
              icon: opening
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.open_in_new, size: 16),
              label: const Text('Abrir ajuste'),
            ),
            if (requirement.kind == ProtectionCheckKind.manual && !done)
              TextButton.icon(
                onPressed: () => _confirmManual(requirement),
                icon: const Icon(Icons.verified_outlined, size: 16),
                label: const Text('Ya lo activé'),
              ),
          ]),
        ]),
      ),
    );
  }
}
