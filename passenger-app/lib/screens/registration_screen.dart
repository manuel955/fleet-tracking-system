import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import '../config.dart';
import '../services/passenger_service.dart';
import '../theme/app_theme.dart';

/// Registro del pasajero (una sola vez): nombre, telefono y foto de la
/// credencial (DNI/carnet). Sin validacion biometrica -- la foto solo
/// queda guardada como referencia.
class RegistrationScreen extends StatefulWidget {
  final VoidCallback onDone;

  const RegistrationScreen({super.key, required this.onDone});

  @override
  State<RegistrationScreen> createState() => _RegistrationScreenState();
}

class _RegistrationScreenState extends State<RegistrationScreen> {
  static const _countryCodes = <({String name, String code})>[
    (name: 'Argentina', code: '+54'),
    (name: 'Bolivia', code: '+591'),
    (name: 'Brasil', code: '+55'),
    (name: 'Chile', code: '+56'),
    (name: 'Colombia', code: '+57'),
    (name: 'Ecuador', code: '+593'),
    (name: 'Guayana Francesa', code: '+594'),
    (name: 'Guyana', code: '+592'),
    (name: 'Paraguay', code: '+595'),
    (name: 'Perú', code: '+51'),
    (name: 'Surinam', code: '+597'),
    (name: 'Uruguay', code: '+598'),
    (name: 'Venezuela', code: '+58'),
  ];

  final _formKey = GlobalKey<FormState>();
  final _nameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  String _countryCode = AppConfig.defaultPhoneCountryCode;

  XFile? _photo;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickPhoto(ImageSource source) async {
    final picked = await ImagePicker().pickImage(
      source: source,
      imageQuality: 80,
      maxWidth: 1024,
    );
    if (picked != null) setState(() => _photo = picked);
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (_photo == null) {
      setState(
        () => _error = 'Toma o elige una foto de tu credencial (DNI/carnet).',
      );
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    final phone = '$_countryCode${_phoneCtrl.text.trim()}';

    try {
      final bytes = await File(_photo!.path).readAsBytes();
      await PassengerService.registerPassenger(
        name: _nameCtrl.text.trim(),
        phone: phone,
        photoBytes: bytes,
      );
      widget.onDone();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = 'Error al registrar: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Registro de pasajero')),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Image.asset(
                    'assets/branding/apl-mark.png',
                    width: 52,
                    height: 52,
                    fit: BoxFit.cover,
                  ),
                  const SizedBox(width: 12),
                  const Text(
                    'APL Logistic',
                    style: TextStyle(
                      color: AppColors.ink,
                      fontSize: 19,
                      fontWeight: FontWeight.w800,
                      letterSpacing: -0.6,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              const Text(
                'Completa tus datos',
                style: TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.5,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'Solo lo pedimos una vez, para poder asignarte un conductor.',
                style: TextStyle(fontSize: 14.5, color: Colors.black54),
              ),
              const SizedBox(height: 28),
              TextFormField(
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: 'Nombre completo'),
                validator: (v) =>
                    (v == null || v.trim().isEmpty) ? 'Requerido' : null,
              ),
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 154,
                    child: DropdownButtonFormField<String>(
                      initialValue: _countryCode,
                      isExpanded: true,
                      decoration: const InputDecoration(labelText: 'Prefijo'),
                      items: _countryCodes
                          .map(
                            (country) => DropdownMenuItem(
                              value: country.code,
                              child: Text(
                                '${country.name} ${country.code}',
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          )
                          .toList(),
                      onChanged: _busy
                          ? null
                          : (value) {
                              if (value != null) {
                                setState(() => _countryCode = value);
                              }
                            },
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: TextFormField(
                      controller: _phoneCtrl,
                      decoration: const InputDecoration(
                        labelText: 'Número de teléfono',
                        hintText: '987654321',
                      ),
                      keyboardType: TextInputType.phone,
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      validator: (value) {
                        final digits = value?.trim() ?? '';
                        if (digits.isEmpty) return 'Requerido';
                        if (digits.length < 6 || digits.length > 15) {
                          return 'Ingresa un número válido';
                        }
                        return null;
                      },
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              const Text(
                'Foto de tu credencial (DNI/carnet)',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 14.5),
              ),
              const SizedBox(height: 10),
              if (_photo != null)
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.file(
                    File(_photo!.path),
                    height: 170,
                    width: double.infinity,
                    fit: BoxFit.cover,
                  ),
                )
              else
                Container(
                  height: 100,
                  width: double.infinity,
                  decoration: BoxDecoration(
                    color: Colors.grey.shade50,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: Colors.grey.shade300,
                      style: BorderStyle.solid,
                    ),
                  ),
                  alignment: Alignment.center,
                  child: Icon(
                    Icons.badge_outlined,
                    color: Colors.grey.shade400,
                    size: 32,
                  ),
                ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () => _pickPhoto(ImageSource.camera),
                      icon: const Icon(Icons.camera_alt_outlined, size: 18),
                      label: const Text('Tomar foto'),
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size.fromHeight(44),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () => _pickPhoto(ImageSource.gallery),
                      icon: const Icon(Icons.photo_library_outlined, size: 18),
                      label: const Text('Galería'),
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size.fromHeight(44),
                      ),
                    ),
                  ),
                ],
              ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(
                  _error!,
                  style: TextStyle(color: Colors.red.shade700, fontSize: 13),
                ),
              ],
              const SizedBox(height: 28),
              ElevatedButton(
                onPressed: _busy ? null : _submit,
                style: ElevatedButton.styleFrom(
                  minimumSize: const Size.fromHeight(52),
                ),
                child: _busy
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Text(
                        'Registrarme',
                        style: TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 15,
                        ),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
