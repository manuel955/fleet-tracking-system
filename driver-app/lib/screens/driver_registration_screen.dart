import 'package:flutter/material.dart';
import '../config.dart';
import '../services/driver_profile_service.dart';
import '../widgets/document_upload_tile.dart';

/// Registro del conductor: cuenta (correo/contraseña) + datos de contacto +
/// los 8 documentos que un admin revisara despues desde el dashboard. Al
/// enviar, el conductor queda con `approvalStatus: 'pending_review'` y no
/// puede operar hasta ser aprobado (ver PendingApprovalScreen).
class DriverRegistrationScreen extends StatefulWidget {
  final VoidCallback onDone;
  final VoidCallback onGoToLogin;

  const DriverRegistrationScreen({super.key, required this.onDone, required this.onGoToLogin});

  @override
  State<DriverRegistrationScreen> createState() => _DriverRegistrationScreenState();
}

class _DriverRegistrationScreenState extends State<DriverRegistrationScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _passwordConfirmCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _ageCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController(text: AppConfig.defaultPhoneCountryCode);
  final _dniCtrl = TextEditingController();
  final _plateCtrl = TextEditingController();

  final Map<String, PickedDocument> _documents = {};
  bool _busy = false;
  String? _error;

  static const _requiredDocs = [
    ('profile', 'Foto de perfil', false),
    ('dni', 'DNI', true),
    ('license', 'Licencia de conducir', true),
    ('soat', 'SOAT', true),
    ('circulationCard', 'Tarjeta única de circulación', true),
    ('technicalReview', 'Revisión técnica vehicular', true),
    ('criminalRecord', 'Récord del conductor', true),
    ('workCertificate', 'Certificado único laboral', true),
  ];

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
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (_passwordCtrl.text != _passwordConfirmCtrl.text) {
      setState(() => _error = 'Las contraseñas no coinciden.');
      return;
    }
    final missing = _requiredDocs.where((d) => !_documents.containsKey(d.$1)).toList();
    if (missing.isNotEmpty) {
      setState(() => _error = 'Falta subir: ${missing.map((d) => d.$2).join(", ")}.');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    var phone = _phoneCtrl.text.trim();
    if (!phone.startsWith('+')) {
      phone = '${AppConfig.defaultPhoneCountryCode}$phone';
    }

    try {
      await DriverProfileService.registerDriver(
        email: _emailCtrl.text.trim(),
        password: _passwordCtrl.text,
        name: _nameCtrl.text.trim(),
        age: int.parse(_ageCtrl.text.trim()),
        phone: phone,
        dni: _dniCtrl.text.trim(),
        plate: _plateCtrl.text.trim(),
        documents: _documents,
      );
      widget.onDone();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
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
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, letterSpacing: -0.5),
              ),
              const SizedBox(height: 6),
              const Text(
                'Completa tus datos y documentos. Un administrador revisará tu registro antes de que puedas empezar a trabajar.',
                style: TextStyle(color: Colors.black54, fontSize: 14.5),
              ),
              const SizedBox(height: 28),
              _sectionLabel('Cuenta'),
              TextFormField(
                controller: _emailCtrl,
                decoration: const InputDecoration(labelText: 'Correo'),
                keyboardType: TextInputType.emailAddress,
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _passwordCtrl,
                decoration: const InputDecoration(labelText: 'Contraseña'),
                obscureText: true,
                validator: (v) => (v == null || v.length < 6) ? 'Mínimo 6 caracteres' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _passwordConfirmCtrl,
                decoration: const InputDecoration(labelText: 'Confirmar contraseña'),
                obscureText: true,
                validator: (v) => (v == null || v.isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 20),
              _sectionLabel('Datos personales'),
              TextFormField(
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: 'Nombre completo'),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _ageCtrl,
                decoration: const InputDecoration(labelText: 'Edad'),
                keyboardType: TextInputType.number,
                validator: (v) {
                  if (v == null || v.trim().isEmpty) return 'Requerido';
                  if (int.tryParse(v.trim()) == null) return 'Debe ser un número';
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _phoneCtrl,
                decoration: const InputDecoration(labelText: 'Teléfono (ej. +51987654321)'),
                keyboardType: TextInputType.phone,
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _dniCtrl,
                decoration: const InputDecoration(labelText: 'DNI (número)'),
                keyboardType: TextInputType.number,
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 20),
              _sectionLabel('Vehículo'),
              TextFormField(
                controller: _plateCtrl,
                decoration: const InputDecoration(labelText: 'Placa del vehículo'),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 24),
              _sectionLabel('Documentos'),
              ..._requiredDocs.map(
                (d) => DocumentUploadTile(
                  label: d.$2,
                  allowPdf: d.$3,
                  onChanged: (file) {
                    setState(() {
                      if (file != null) {
                        _documents[d.$1] = file;
                      } else {
                        _documents.remove(d.$1);
                      }
                    });
                  },
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(_error!, style: TextStyle(color: Colors.red.shade700, fontSize: 13)),
              ],
              const SizedBox(height: 28),
              ElevatedButton(
                onPressed: _busy ? null : _submit,
                style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                child: _busy
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Text('Enviar registro', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: widget.onGoToLogin,
                child: const Text(
                  '¿Ya tienes cuenta? Inicia sesión',
                  style: TextStyle(fontWeight: FontWeight.w600, color: Colors.black),
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
