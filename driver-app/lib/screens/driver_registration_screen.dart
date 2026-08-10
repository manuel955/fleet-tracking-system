import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config.dart';
import '../services/driver_profile_service.dart';
import '../widgets/document_upload_tile.dart';

/// Registro del conductor: cuenta (correo/contraseña) + datos de contacto +
/// documentos obligatorios que un admin puede revisar despues desde el
/// dashboard. Al enviar, el conductor queda con
/// `approvalStatus: 'pending_review'` y no puede operar hasta ser aprobado
/// (ver PendingApprovalScreen).
class DriverRegistrationScreen extends StatefulWidget {
  final VoidCallback onDone;
  final VoidCallback onGoToLogin;

  const DriverRegistrationScreen(
      {super.key, required this.onDone, required this.onGoToLogin});

  @override
  State<DriverRegistrationScreen> createState() =>
      _DriverRegistrationScreenState();
}

class _DriverRegistrationScreenState extends State<DriverRegistrationScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _passwordConfirmCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _ageCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _dniCtrl = TextEditingController();
  final _plateCtrl = TextEditingController();
  final _vehicleBrandCtrl = TextEditingController();
  final _vehicleColorCtrl = TextEditingController();
  final _vehicleSeatsCtrl = TextEditingController();
  String? _vehicleType;
  String _phonePrefix = AppConfig.defaultPhoneCountryCode;

  final Map<String, List<PickedDocument>> _documents = {};
  final Map<String, DateTime> _documentExpiries = {};
  bool _busy = false;
  bool _acceptedPrivacy = false;
  String? _error;

  static const _vehicleTypes = [
    'Auto',
    'SUV',
    'Mini van',
    'Van',
    'Mini bus',
    'Bus',
  ];

  static const _vehicleColors = [
    'Negro',
    'Gris',
    'Plata',
    'Blanco',
  ];

  static const _passengerRanges = <String, List<int>>{
    'Auto': [1, 4],
    'SUV': [5, 7],
    'Mini van': [8, 17],
    'Van': [18, 20],
    'Mini bus': [21, 38],
    'Bus': [39, 45],
  };

  static const _phoneCountries = [
    ('Argentina', '+54'),
    ('Belice', '+501'),
    ('Bolivia', '+591'),
    ('Brasil', '+55'),
    ('Chile', '+56'),
    ('Colombia', '+57'),
    ('Costa Rica', '+506'),
    ('Cuba', '+53'),
    ('Ecuador', '+593'),
    ('El Salvador', '+503'),
    ('Guatemala', '+502'),
    ('Guyana', '+592'),
    ('Haití', '+509'),
    ('Honduras', '+504'),
    ('México', '+52'),
    ('Nicaragua', '+505'),
    ('Panamá', '+507'),
    ('Paraguay', '+595'),
    ('Perú', '+51'),
    ('Puerto Rico', '+1787'),
    ('República Dominicana', '+1809'),
    ('Surinam', '+597'),
    ('Uruguay', '+598'),
    ('Venezuela', '+58'),
  ];

  static const _documentFields = [
    ('profile', 'Foto de perfil', false),
    ('dni', 'DNI', true),
    ('license', 'Licencia de conducir', true),
    ('soat', 'SOAT', true),
    ('circulationCard', 'Tarjeta única de circulación', true),
    ('technicalReview', 'Revisión técnica vehicular', true),
    ('criminalRecord', 'Récord del conductor', true),
    ('workCertificate', 'Certificado único laboral', true),
  ];

  static const _expiryLabels = {
    'license': 'Vencimiento de la licencia',
    'soat': 'Vencimiento del SOAT',
    'technicalReview': 'Vencimiento de la revisión técnica',
  };

  @override
  void dispose() {
    _emailCtrl.dispose();
    _passwordCtrl.dispose();
    _passwordConfirmCtrl.dispose();
    _nameCtrl.dispose();
    _ageCtrl.dispose();
    _phoneCtrl.dispose();
    _dniCtrl.dispose();
    _plateCtrl.dispose();
    _vehicleBrandCtrl.dispose();
    _vehicleColorCtrl.dispose();
    _vehicleSeatsCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (!_acceptedPrivacy) {
      setState(
          () => _error = 'Acepta la política de privacidad para continuar.');
      return;
    }
    final missingDocuments = _documentFields
        .where((document) =>
            (_documents[document.$1] ?? const <PickedDocument>[]).isEmpty)
        .map((document) => document.$2)
        .toList();
    if (missingDocuments.isNotEmpty) {
      setState(() => _error =
          'Todos los documentos son obligatorios. Falta: ${missingDocuments.join(', ')}.');
      return;
    }
    final missingExpiries = _expiryLabels.entries
        .where((entry) => !_documentExpiries.containsKey(entry.key))
        .map((entry) => entry.value)
        .toList();
    if (missingExpiries.isNotEmpty) {
      setState(() => _error = 'Selecciona: ${missingExpiries.join(', ')}.');
      return;
    }
    if (!_isDniSelectionValid) {
      setState(() => _error = 'El DNI requiere 2 fotos o 1 solo PDF.');
      return;
    }
    if (_passwordCtrl.text != _passwordConfirmCtrl.text) {
      setState(() => _error = 'Las contraseñas no coinciden.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });

    final phone = '$_phonePrefix${_phoneCtrl.text.trim()}';

    try {
      await DriverProfileService.registerDriver(
        email: _emailCtrl.text.trim(),
        password: _passwordCtrl.text,
        name: _nameCtrl.text.trim(),
        age: int.parse(_ageCtrl.text.trim()),
        phone: phone,
        dni: _dniCtrl.text.trim(),
        plate: _plateCtrl.text.trim(),
        vehicleBrand: _vehicleBrandCtrl.text.trim(),
        vehicleType: _vehicleType!,
        vehicleColor: _vehicleColorCtrl.text.trim(),
        vehicleSeats: int.parse(_vehicleSeatsCtrl.text.trim()),
        documents: _documents,
        documentExpiries: {
          for (final entry in _documentExpiries.entries)
            entry.key: entry.value.millisecondsSinceEpoch,
        },
      );
      widget.onDone();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  Future<void> _openPrivacyPolicy() async {
    await launchUrl(
      Uri.parse(AppConfig.privacyPolicyUrl),
      mode: LaunchMode.externalApplication,
    );
  }

  bool get _isDniSelectionValid {
    final dni = _documents['dni'] ?? const <PickedDocument>[];
    if (dni.length == 1) return dni.single.extension == 'pdf';
    return dni.length == 2 && dni.every((file) => file.extension != 'pdf');
  }

  Future<void> _pickExpiry(String key) async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final selected = await showDatePicker(
      context: context,
      initialDate: _documentExpiries[key] ?? today.add(const Duration(days: 1)),
      firstDate: today.add(const Duration(days: 1)),
      lastDate: DateTime(now.year + 15, 12, 31),
      helpText: _expiryLabels[key],
    );
    if (selected == null || !mounted) return;
    setState(() {
      _documentExpiries[key] = DateTime(
        selected.year,
        selected.month,
        selected.day,
        23,
        59,
        59,
      );
    });
  }

  Widget _expiryPicker(String key) {
    final selected = _documentExpiries[key];
    final value = selected == null
        ? 'Seleccionar fecha'
        : '${selected.day.toString().padLeft(2, '0')}/'
            '${selected.month.toString().padLeft(2, '0')}/${selected.year}';
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: OutlinedButton.icon(
        onPressed: _busy ? null : () => _pickExpiry(key),
        icon: const Icon(Icons.event_outlined),
        label: Align(
          alignment: Alignment.centerLeft,
          child: Text('${_expiryLabels[key]}: $value'),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Registro de conductor')),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              const Text(
                'Únete como conductor',
                style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -0.5),
              ),
              const SizedBox(height: 6),
              const Text(
                'Completa tus datos y todos los documentos. Para el DNI sube 2 fotos o 1 solo PDF. La licencia, el SOAT y la revisión técnica deben estar vigentes.',
                style: TextStyle(color: Colors.black54, fontSize: 14.5),
              ),
              const SizedBox(height: 28),
              _sectionLabel('Cuenta'),
              TextFormField(
                controller: _emailCtrl,
                decoration: const InputDecoration(labelText: 'Correo'),
                keyboardType: TextInputType.emailAddress,
                validator: (v) =>
                    (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _passwordCtrl,
                decoration: const InputDecoration(labelText: 'Contraseña'),
                obscureText: true,
                validator: (v) =>
                    (v == null || v.length < 6) ? 'Mínimo 6 caracteres' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _passwordConfirmCtrl,
                decoration:
                    const InputDecoration(labelText: 'Confirmar contraseña'),
                obscureText: true,
                validator: (v) => (v == null || v.isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 20),
              _sectionLabel('Datos personales'),
              TextFormField(
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: 'Nombre completo'),
                validator: (v) =>
                    (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _ageCtrl,
                decoration: const InputDecoration(labelText: 'Edad'),
                keyboardType: TextInputType.number,
                validator: (v) {
                  if (v == null || v.trim().isEmpty) return 'Requerido';
                  final age = int.tryParse(v.trim());
                  if (age == null) return 'Debe ser un número';
                  if (age <= 17 || age >= 100) {
                    return 'La edad debe estar entre 18 y 99 años';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 148,
                    child: DropdownButtonFormField<String>(
                      initialValue: _phonePrefix,
                      decoration: const InputDecoration(labelText: 'Prefijo'),
                      items: _phoneCountries
                          .map((country) => DropdownMenuItem(
                                value: country.$2,
                                child: Text(
                                  '${country.$1} ${country.$2}',
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ))
                          .toList(),
                      onChanged: (value) {
                        if (value != null) {
                          setState(() => _phonePrefix = value);
                        }
                      },
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: TextFormField(
                      controller: _phoneCtrl,
                      decoration: const InputDecoration(labelText: 'Número'),
                      keyboardType: TextInputType.phone,
                      validator: (v) {
                        final value = v?.trim() ?? '';
                        if (value.isEmpty) return 'Requerido';
                        if (!RegExp(r'^\d{6,15}$').hasMatch(value)) {
                          return 'Usa entre 6 y 15 dígitos';
                        }
                        return null;
                      },
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _dniCtrl,
                decoration: const InputDecoration(labelText: 'DNI (número)'),
                keyboardType: TextInputType.number,
                validator: (v) =>
                    (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 20),
              _sectionLabel('Vehículo'),
              TextFormField(
                controller: _plateCtrl,
                decoration:
                    const InputDecoration(labelText: 'Placa del vehículo'),
                validator: (v) =>
                    (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _vehicleBrandCtrl,
                decoration: const InputDecoration(
                    labelText: 'Marca del vehiculo (ej. Toyota)'),
                validator: (v) =>
                    (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: _vehicleType,
                decoration:
                    const InputDecoration(labelText: 'Tipo de vehiculo'),
                items: _vehicleTypes
                    .map((type) => DropdownMenuItem(
                          value: type,
                          child: Text(type),
                        ))
                    .toList(),
                onChanged: (value) => setState(() {
                  _vehicleType = value;
                  _vehicleSeatsCtrl.clear();
                }),
                validator: (value) => value == null ? 'Requerido' : null,
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: _vehicleColorCtrl.text.isEmpty
                    ? null
                    : _vehicleColorCtrl.text,
                decoration:
                    const InputDecoration(labelText: 'Color del vehiculo'),
                items: _vehicleColors
                    .map((color) => DropdownMenuItem(
                          value: color,
                          child: Text(color),
                        ))
                    .toList(),
                onChanged: (value) =>
                    setState(() => _vehicleColorCtrl.text = value ?? ''),
                validator: (value) => value == null ? 'Requerido' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _vehicleSeatsCtrl,
                decoration: InputDecoration(
                  labelText: 'Numero de asientos',
                  helperText: _vehicleType == null
                      ? 'Selecciona primero el tipo de vehiculo'
                      : 'Guia: ${_passengerRanges[_vehicleType]![0]} a ${_passengerRanges[_vehicleType]![1]} pasajeros',
                ),
                keyboardType: TextInputType.number,
                validator: (v) {
                  final range = _passengerRanges[_vehicleType];
                  final seats = int.tryParse(v?.trim() ?? '');
                  if (range == null) return 'Selecciona el tipo de vehiculo';
                  if (seats == null || seats < range[0] || seats > range[1]) {
                    return 'Ingresa entre ${range[0]} y ${range[1]} pasajeros';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 24),
              _sectionLabel('Documentos'),
              ..._documentFields.expand<Widget>((d) => [
                    DocumentUploadTile(
                      key: ValueKey(d.$1),
                      label: '${d.$2} (obligatorio)',
                      allowPdf: d.$3,
                      dniMode: d.$1 == 'dni',
                      files: _documents[d.$1] ?? const <PickedDocument>[],
                      onChanged: (file) {
                        setState(() {
                          if (file.isNotEmpty) {
                            _documents[d.$1] = file;
                          } else {
                            _documents.remove(d.$1);
                          }
                        });
                      },
                    ),
                    if (_expiryLabels.containsKey(d.$1)) _expiryPicker(d.$1),
                  ]),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: _acceptedPrivacy,
                onChanged: _busy
                    ? null
                    : (value) =>
                        setState(() => _acceptedPrivacy = value ?? false),
                controlAffinity: ListTileControlAffinity.leading,
                title: GestureDetector(
                  onTap: _openPrivacyPolicy,
                  child: const Text(
                    'He leído y acepto la política de privacidad y el uso operativo de mi ubicación durante el turno',
                    style: TextStyle(
                      decoration: TextDecoration.underline,
                      fontSize: 13,
                    ),
                  ),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(_error!,
                    style: TextStyle(color: Colors.red.shade700, fontSize: 13)),
              ],
              const SizedBox(height: 28),
              ElevatedButton(
                onPressed: _busy ? null : _submit,
                style: ElevatedButton.styleFrom(
                    minimumSize: const Size.fromHeight(52)),
                child: _busy
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white),
                      )
                    : const Text('Enviar registro',
                        style: TextStyle(
                            fontWeight: FontWeight.w700, fontSize: 15)),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: widget.onGoToLogin,
                child: const Text(
                  '¿Ya tienes cuenta? Inicia sesión',
                  style: TextStyle(
                      fontWeight: FontWeight.w600, color: Colors.black),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _sectionLabel(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.6,
          color: Colors.grey.shade500,
        ),
      ),
    );
  }
}
