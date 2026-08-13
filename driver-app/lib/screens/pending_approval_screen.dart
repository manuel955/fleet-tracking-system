import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config.dart';
import '../services/auth_service.dart';
import '../services/driver_profile_service.dart';
import '../theme/app_theme.dart';
import '../widgets/document_upload_tile.dart';
import 'notifications_screen.dart';

/// Se muestra mientras `approvalStatus` sigue en 'pending_review', o si fue
/// 'rejected' (con motivo de texto libre escrito por el admin desde el
/// dashboard). Si fue rechazado, el conductor puede volver a subir solo los
/// documentos que necesiten corregirse, sin repetir el registro completo.
class PendingApprovalScreen extends StatefulWidget {
  final Map<String, dynamic> profile;
  final VoidCallback onLoggedOut;
  final VoidCallback onResubmitted;

  const PendingApprovalScreen({
    super.key,
    required this.profile,
    required this.onLoggedOut,
    required this.onResubmitted,
  });

  @override
  State<PendingApprovalScreen> createState() => _PendingApprovalScreenState();
}

class _PendingApprovalScreenState extends State<PendingApprovalScreen> {
  bool _resubmitting = false;
  bool _busy = false;
  bool _deleting = false;
  String? _error;
  final Map<String, List<PickedDocument>> _documents = {};
  final _nameCtrl = TextEditingController();
  final _ageCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _dniCtrl = TextEditingController();
  final _plateCtrl = TextEditingController();
  final _vehicleBrandCtrl = TextEditingController();
  final _vehicleSeatsCtrl = TextEditingController();
  String? _vehicleType;
  String? _vehicleColor;

  static const _vehicleTypes = [
    'Auto',
    'SUV',
    'Mini van',
    'Van',
    'Mini bus',
    'Bus',
  ];
  static const _vehicleColors = ['Negro', 'Gris', 'Plata', 'Blanco'];
  static const _passengerRanges = <String, List<int>>{
    'Auto': [1, 4],
    'SUV': [5, 7],
    'Mini van': [8, 17],
    'Van': [18, 20],
    'Mini bus': [21, 38],
    'Bus': [39, 45],
  };

  static const _docs = [
    ('profile', 'Foto de perfil', false, ['profilePhotoUrl']),
    (
      'dni',
      'DNI (2 fotos o 1 PDF)',
      true,
      ['dniDocUrl', 'dniFrontDocUrl', 'dniBackDocUrl']
    ),
    ('license', 'Licencia de conducir', true, ['licenseDocUrl']),
    ('soat', 'SOAT', true, ['soatDocUrl']),
    (
      'circulationCard',
      'Tarjeta única de circulación',
      true,
      ['circulationCardDocUrl']
    ),
    (
      'technicalReview',
      'Revisión técnica vehicular',
      true,
      ['technicalReviewDocUrl']
    ),
    ('criminalRecord', 'Récord del conductor', true, ['criminalRecordDocUrl']),
    (
      'workCertificate',
      'Certificado único laboral',
      true,
      ['workCertificateDocUrl']
    ),
  ];

  @override
  void initState() {
    super.initState();
    _nameCtrl.text = widget.profile['name']?.toString() ?? '';
    _ageCtrl.text = widget.profile['age']?.toString() ?? '';
    _phoneCtrl.text = widget.profile['phone']?.toString() ?? '';
    _dniCtrl.text = widget.profile['dni']?.toString() ?? '';
    _plateCtrl.text = widget.profile['plate']?.toString() ?? '';
    _vehicleBrandCtrl.text = widget.profile['vehicleBrand']?.toString() ?? '';
    _vehicleSeatsCtrl.text = widget.profile['vehicleSeats']?.toString() ?? '';
    _vehicleType = widget.profile['vehicleType']?.toString();
    _vehicleColor = widget.profile['vehicleColor']?.toString();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _ageCtrl.dispose();
    _phoneCtrl.dispose();
    _dniCtrl.dispose();
    _plateCtrl.dispose();
    _vehicleBrandCtrl.dispose();
    _vehicleSeatsCtrl.dispose();
    super.dispose();
  }

  Set<String> get _rejectedDocumentKeys {
    final raw = widget.profile['rejectionFieldKeys']?.toString() ?? '';
    return raw
        .split(',')
        .map((key) => key.trim())
        .where((key) => key.isNotEmpty)
        .toSet();
  }

  bool get _personalDataRejected =>
      _rejectedDocumentKeys.contains('personalData');

  bool get _vehicleDataRejected =>
      _rejectedDocumentKeys.contains('vehicleData');

  Iterable<dynamic> get _visibleDocs {
    final keys = _rejectedDocumentKeys;
    if (keys.isEmpty) return _docs;
    return _docs.where((document) => keys.contains(document.$1));
  }

  String get _visibleCorrectionLabels {
    final labels = <String>[
      if (_personalDataRejected) 'datos personales',
      if (_vehicleDataRejected) 'datos del vehículo',
      ..._visibleDocs.map((document) => document.$2),
    ];
    return labels.join(', ');
  }

  bool get _isDniSelectionValid {
    final dni = _documents['dni'] ?? const <PickedDocument>[];
    if (dni.isEmpty) return true;
    if (dni.length == 1) return dni.single.extension == 'pdf';
    return dni.length == 2 && dni.every((file) => file.extension != 'pdf');
  }

  Future<void> _submitResubmission() async {
    if (_documents.isEmpty && !_personalDataRejected && !_vehicleDataRejected) {
      setState(
          () => _error = 'Sube al menos un documento para volver a enviarlo.');
      return;
    }
    final requiredDocumentKeys = _rejectedDocumentKeys.isEmpty
        ? <String>{}
        : _visibleDocs.map<String>((document) => document.$1).toSet();
    final missingDocumentKeys =
        requiredDocumentKeys.difference(_documents.keys.toSet());
    if (missingDocumentKeys.isNotEmpty) {
      setState(() => _error =
          'Vuelve a subir todos los documentos indicados antes de enviar.');
      return;
    }
    if (!_isDniSelectionValid) {
      setState(() => _error = 'El DNI requiere 2 fotos o 1 solo PDF.');
      return;
    }
    final profileChanges = <String, dynamic>{};
    if (_personalDataRejected) {
      final name = _nameCtrl.text.trim();
      final age = int.tryParse(_ageCtrl.text.trim());
      final phone = _phoneCtrl.text.trim();
      final dni = _dniCtrl.text.trim();
      if (name.length < 2 ||
          age == null ||
          age < 18 ||
          age > 99 ||
          !RegExp(r'^\+\d{8,19}$').hasMatch(phone) ||
          dni.length < 6 ||
          dni.length > 20) {
        setState(() => _error =
            'Revisa nombre, edad, teléfono con prefijo internacional y DNI.');
        return;
      }
      profileChanges.addAll({
        'name': name,
        'age': age,
        'phone': phone,
        'dni': dni,
      });
    }
    if (_vehicleDataRejected) {
      final range = _passengerRanges[_vehicleType];
      final seats = int.tryParse(_vehicleSeatsCtrl.text.trim());
      if (_plateCtrl.text.trim().length < 4 ||
          _vehicleBrandCtrl.text.trim().length < 2 ||
          range == null ||
          _vehicleColor == null ||
          seats == null ||
          seats < range[0] ||
          seats > range[1]) {
        setState(() => _error = 'Revisa todos los datos del vehículo.');
        return;
      }
      profileChanges.addAll({
        'plate': _plateCtrl.text.trim(),
        'vehicleBrand': _vehicleBrandCtrl.text.trim(),
        'vehicleType': _vehicleType,
        'vehicleColor': _vehicleColor,
        'vehicleSeats': seats,
      });
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await DriverProfileService.resubmitDocuments(
        _documents,
        profileChanges: profileChanges,
      );
      widget.onResubmitted();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  Widget _correctionField(
    TextEditingController controller,
    String label, {
    TextInputType? keyboardType,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextField(
        controller: controller,
        keyboardType: keyboardType,
        decoration: InputDecoration(labelText: label),
      ),
    );
  }

  Widget _personalCorrections() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('Datos personales',
            style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 10),
        _correctionField(_nameCtrl, 'Nombre completo'),
        _correctionField(_ageCtrl, 'Edad', keyboardType: TextInputType.number),
        _correctionField(
          _phoneCtrl,
          'Teléfono con prefijo (ej. +51999111222)',
          keyboardType: TextInputType.phone,
        ),
        _correctionField(_dniCtrl, 'DNI', keyboardType: TextInputType.number),
        const SizedBox(height: 8),
      ],
    );
  }

  Widget _vehicleCorrections() {
    final range = _passengerRanges[_vehicleType];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('Datos del vehículo',
            style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 10),
        _correctionField(_plateCtrl, 'Placa'),
        _correctionField(_vehicleBrandCtrl, 'Marca'),
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: DropdownButtonFormField<String>(
            initialValue:
                _vehicleTypes.contains(_vehicleType) ? _vehicleType : null,
            decoration: const InputDecoration(labelText: 'Tipo de vehículo'),
            items: _vehicleTypes
                .map((value) =>
                    DropdownMenuItem(value: value, child: Text(value)))
                .toList(),
            onChanged: (value) => setState(() => _vehicleType = value),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: DropdownButtonFormField<String>(
            initialValue:
                _vehicleColors.contains(_vehicleColor) ? _vehicleColor : null,
            decoration: const InputDecoration(labelText: 'Color'),
            items: _vehicleColors
                .map((value) =>
                    DropdownMenuItem(value: value, child: Text(value)))
                .toList(),
            onChanged: (value) => setState(() => _vehicleColor = value),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: TextField(
            controller: _vehicleSeatsCtrl,
            keyboardType: TextInputType.number,
            decoration: InputDecoration(
              labelText: 'Número de asientos',
              helperText: range == null
                  ? 'Selecciona primero el tipo de vehículo'
                  : 'Permitido: ${range[0]} a ${range[1]} pasajeros',
            ),
          ),
        ),
        const SizedBox(height: 8),
      ],
    );
  }

  Future<void> _logout() async {
    await AuthService.logout();
    widget.onLoggedOut();
  }

  Future<void> _deleteAccount() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Eliminar cuenta y datos'),
        content: const Text(
            'Se eliminarán tu registro, documentos y datos asociados. Esta acción no se puede deshacer.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancelar')),
          TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Eliminar todo',
                  style: TextStyle(color: AppColors.red))),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _deleting = true);
    try {
      await AuthService.deleteCurrentAccount();
      widget.onLoggedOut();
    } catch (error) {
      if (!mounted) return;
      setState(() => _deleting = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(error.toString().replaceFirst('Exception: ', ''))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final status =
        widget.profile['approvalStatus'] as String? ?? 'pending_review';
    final suspended = widget.profile['suspended'] == true;
    final rejected = !suspended && status == 'rejected';
    final reason = suspended
        ? widget.profile['suspensionReason'] as String?
        : widget.profile['rejectionReason'] as String?;

    return Scaffold(
      appBar: AppBar(
        title: Text(suspended
            ? 'Cuenta suspendida'
            : (rejected ? 'Registro rechazado' : 'Registro enviado')),
        automaticallyImplyLeading: false,
        actions: [
          NotificationBellButton(
            onCorrect:
                rejected ? () => setState(() => _resubmitting = true) : null,
          ),
          IconButton(
              icon: const Icon(Icons.logout),
              tooltip: 'Cerrar sesión',
              onPressed: _logout),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Icon(
              suspended
                  ? Icons.block_outlined
                  : (rejected ? Icons.error_outline : Icons.hourglass_top),
              size: 56,
              color: (suspended || rejected) ? AppColors.red : AppColors.amber,
            ),
            const SizedBox(height: 16),
            Text(
              rejected
                  ? 'Tu registro fue rechazado'
                  : (suspended
                      ? 'Tu cuenta está suspendida'
                      : 'Tu registro está en revisión'),
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Text(
              rejected
                  ? 'Corrige exactamente los datos o documentos indicados. Mientras tu registro esté rechazado no puedes conectarte, enviar ubicación ni recibir viajes.'
                  : (suspended
                      ? 'No puedes iniciar turno, enviar ubicación ni recibir viajes. Comunícate con operaciones si necesitas aclarar la suspensión.'
                      : 'Un administrador está revisando tus documentos. Te avisaremos cuando puedas empezar a trabajar.'),
              style: const TextStyle(color: AppColors.muted),
            ),
            if ((rejected || suspended) &&
                reason != null &&
                reason.isNotEmpty) ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.red.withValues(alpha: .10),
                  borderRadius: BorderRadius.circular(12),
                  border:
                      Border.all(color: AppColors.red.withValues(alpha: .35)),
                ),
                child: Text(
                    '${suspended ? 'Motivo de suspensión' : 'Motivo'}: $reason',
                    style: const TextStyle(color: AppColors.red)),
              ),
            ],
            if (rejected && _rejectedDocumentKeys.isNotEmpty) ...[
              const SizedBox(height: 12),
              Text(
                'Debes corregir: $_visibleCorrectionLabels',
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ],
            if (rejected) ...[
              const SizedBox(height: 20),
              if (!_resubmitting)
                ElevatedButton(
                  onPressed: () => setState(() => _resubmitting = true),
                  style: ElevatedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48)),
                  child: const Text('Volver a subir documentos'),
                )
              else ...[
                const Text(
                  'Completa todas las correcciones indicadas:',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 12),
                if (_personalDataRejected) _personalCorrections(),
                if (_vehicleDataRejected) _vehicleCorrections(),
                ..._visibleDocs.expand<Widget>((d) => [
                      DocumentUploadTile(
                        key: ValueKey(d.$1),
                        label: d.$2,
                        allowPdf: d.$3,
                        dniMode: d.$1 == 'dni',
                        files: _documents[d.$1] ?? const <PickedDocument>[],
                        existingUrls: [
                          for (final field in d.$4)
                            if ((widget.profile[field]?.toString() ?? '')
                                .isNotEmpty)
                              widget.profile[field].toString(),
                        ],
                        onChanged: (files) {
                          setState(() {
                            if (files.isNotEmpty) {
                              _documents[d.$1] = files;
                            } else {
                              _documents.remove(d.$1);
                            }
                          });
                        },
                      ),
                    ]),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: const TextStyle(color: AppColors.red)),
                ],
                const SizedBox(height: 16),
                ElevatedButton(
                  onPressed: _busy ? null : _submitResubmission,
                  style: ElevatedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48)),
                  child: _busy
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white),
                        )
                      : const Text('Enviar de nuevo'),
                ),
              ],
            ],
            const SizedBox(height: 24),
            OutlinedButton(
              onPressed: _deleting ? null : _deleteAccount,
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.red,
                side: const BorderSide(color: AppColors.red),
                minimumSize: const Size.fromHeight(48),
              ),
              child: const Text('Eliminar cuenta y datos'),
            ),
            TextButton(
              onPressed: () => launchUrl(Uri.parse(AppConfig.privacyPolicyUrl),
                  mode: LaunchMode.externalApplication),
              child: const Text('Política de privacidad'),
            ),
          ],
        ),
      ),
    );
  }
}
