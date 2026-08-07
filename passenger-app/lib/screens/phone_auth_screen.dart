import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../theme/app_theme.dart';

/// Vincula o recupera una cuenta de pasajero mediante un código SMS.
class PhoneAuthScreen extends StatefulWidget {
  final String? initialPhone;
  final Future<void> Function(Map<String, dynamic> session) onAuthenticated;

  const PhoneAuthScreen({
    super.key,
    this.initialPhone,
    required this.onAuthenticated,
  });

  @override
  State<PhoneAuthScreen> createState() => _PhoneAuthScreenState();
}

class _PhoneAuthScreenState extends State<PhoneAuthScreen> {
  late final TextEditingController _phoneController;
  final _codeController = TextEditingController();
  String? _verificationId;
  int? _resendToken;
  bool _busy = false;
  bool _completionStarted = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _phoneController = TextEditingController(
      text: _displayPhone(widget.initialPhone),
    );
  }

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  static String _displayPhone(String? value) {
    final phone = value?.trim() ?? '';
    if (phone.isEmpty) return '+51 ';
    return phone.startsWith('+') ? phone : '+51 $phone';
  }

  static String _normalizedPhone(String value) {
    final trimmed = value.trim();
    if (trimmed.startsWith('+')) {
      return '+${trimmed.substring(1).replaceAll(RegExp(r'\D'), '')}';
    }
    var digits = trimmed.replaceAll(RegExp(r'\D'), '');
    if (digits.startsWith('0')) digits = digits.substring(1);
    if (!digits.startsWith('51')) digits = '51$digits';
    return '+$digits';
  }

  String _friendlyError(Object error) {
    if (error is FirebaseAuthException) {
      switch (error.code) {
        case 'invalid-phone-number':
          return 'Escribe un número válido con código de país, por ejemplo +51 986969857.';
        case 'too-many-requests':
          return 'Se alcanzó el límite temporal de intentos. Espera unos minutos y vuelve a intentar.';
        case 'quota-exceeded':
          return 'Se alcanzó el límite de SMS de Firebase. Intenta más tarde.';
        case 'captcha-check-failed':
          return 'No se pudo verificar el dispositivo. Revisa tu conexión e intenta nuevamente.';
        case 'session-expired':
          return 'El código venció. Solicita un código nuevo.';
        case 'invalid-verification-code':
          return 'El código ingresado no es válido.';
        case 'credential-already-in-use':
          return 'Este número ya está vinculado a otra cuenta.';
        case 'operation-not-allowed':
          return 'El acceso por teléfono todavía no está habilitado en el servidor.';
        default:
          return error.message ?? 'No se pudo verificar el número.';
      }
    }
    return error.toString().replaceFirst('Exception: ', '');
  }

  Future<void> _sendCode() async {
    final phone = _normalizedPhone(_phoneController.text);
    if (phone.length < 10) {
      setState(() => _error = 'Escribe tu número completo con código de país.');
      return;
    }
    setState(() {
      _busy = true;
      _completionStarted = false;
      _error = null;
    });
    try {
      await AuthService.sendPhoneCode(
        phoneNumber: phone,
        onCodeSent: (verificationId, resendToken) {
          if (!mounted) return;
          setState(() {
            _verificationId = verificationId;
            _resendToken = resendToken;
            _busy = false;
          });
        },
        onVerificationFailed: (error) {
          if (!mounted) return;
          setState(() {
            _busy = false;
            _error = _friendlyError(error);
          });
        },
        onVerificationCompleted: _completeCredential,
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _friendlyError(error);
      });
    }
  }

  Future<void> _completeCredential(PhoneAuthCredential credential) async {
    if (_completionStarted) return;
    _completionStarted = true;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final session = await AuthService.finishPhoneCredential(credential);
      await widget.onAuthenticated(session);
      if (mounted) Navigator.of(context).pop();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _completionStarted = false;
        _error = _friendlyError(error);
      });
    }
  }

  Future<void> _verifyCode() async {
    final verificationId = _verificationId;
    final code = _codeController.text.trim();
    if (verificationId == null || code.length < 6 || _busy) return;
    _completionStarted = true;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final session = await AuthService.finishPhoneCode(
        verificationId: verificationId,
        code: code,
      );
      await widget.onAuthenticated(session);
      if (mounted) Navigator.of(context).pop();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _completionStarted = false;
        _error = _friendlyError(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final codeSent = _verificationId != null;
    return Scaffold(
      appBar: AppBar(title: const Text('Acceso con teléfono')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const Icon(
              Icons.phone_android_outlined,
              size: 54,
              color: AppColors.ink,
            ),
            const SizedBox(height: 18),
            const Text(
              'Recupera tu cuenta',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 27, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 10),
            Text(
              codeSent
                  ? 'Te enviamos un código por SMS. Escríbelo para continuar.'
                  : 'Vincula tu número para poder cerrar sesión y volver a entrar más adelante.',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.black54, height: 1.35),
            ),
            const SizedBox(height: 28),
            TextField(
              controller: _phoneController,
              enabled: !codeSent && !_busy,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                labelText: 'Número de teléfono',
                hintText: '+51 986969857',
                prefixIcon: Icon(Icons.phone_outlined),
              ),
            ),
            if (codeSent) ...[
              const SizedBox(height: 16),
              TextField(
                controller: _codeController,
                enabled: !_busy,
                autofocus: true,
                keyboardType: TextInputType.number,
                maxLength: 6,
                decoration: const InputDecoration(
                  labelText: 'Código SMS',
                  prefixIcon: Icon(Icons.lock_outline),
                  counterText: '',
                ),
              ),
            ],
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: _busy ? null : (codeSent ? _verifyCode : _sendCode),
              child: Text(
                _busy
                    ? 'Verificando…'
                    : codeSent
                    ? 'Verificar y continuar'
                    : 'Enviar código SMS',
              ),
            ),
            if (codeSent) ...[
              const SizedBox(height: 8),
              TextButton(
                onPressed: _busy
                    ? null
                    : () {
                        setState(() {
                          _verificationId = null;
                          _codeController.clear();
                          _completionStarted = false;
                          _error = null;
                        });
                      },
                child: const Text('Cambiar número'),
              ),
              if (_resendToken != null)
                TextButton(
                  onPressed: _busy ? null : _sendCode,
                  child: const Text('Reenviar código'),
                ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 18),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.red.shade700),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
