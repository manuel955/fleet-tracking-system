import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config.dart';
import '../services/auth_service.dart';
import '../theme/app_theme.dart';
import 'notifications_screen.dart';

class LoginScreen extends StatefulWidget {
  final VoidCallback onLoggedIn;
  final VoidCallback onGoToRegister;

  const LoginScreen(
      {super.key, required this.onLoggedIn, required this.onGoToRegister});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _emailCtrl.dispose();
    _passwordCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await AuthService.signInWithEmail(
          email: _emailCtrl.text.trim(), password: _passwordCtrl.text);
      widget.onLoggedIn();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  Future<void> _resetPassword() async {
    final email = _emailCtrl.text.trim();
    if (email.isEmpty || !email.contains('@')) {
      setState(() => _error = 'Escribe primero el correo de tu cuenta.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await AuthService.sendPasswordResetEmail(email);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Si el correo esta registrado, recibiras un enlace para cambiar la contrasena.',
          ),
        ),
      );
      setState(() => _busy = false);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Form(
              key: _formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Align(
                    alignment: Alignment.centerRight,
                    child: NotificationBellButton(floating: true),
                  ),
                  const SizedBox(height: 8),
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
                  const SizedBox(height: 20),
                  const Text(
                    'Hola, conductor',
                    style: TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.w800,
                        letterSpacing: -0.5),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Inicia sesión para empezar tu turno',
                    style: TextStyle(color: AppColors.muted, fontSize: 14.5),
                  ),
                  const SizedBox(height: 32),
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
                        (v == null || v.isEmpty) ? 'Requerido' : null,
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    Text(_error!,
                        style: const TextStyle(
                            color: AppColors.red, fontSize: 13)),
                  ],
                  const SizedBox(height: 24),
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
                        : const Text('Entrar',
                            style: TextStyle(
                                fontWeight: FontWeight.w700, fontSize: 15)),
                  ),
                  TextButton(
                    onPressed: _busy ? null : _resetPassword,
                    child: const Text('Olvide mi contrasena'),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: widget.onGoToRegister,
                    child: const Text(
                      '¿No tienes cuenta? Regístrate',
                      style: TextStyle(
                          fontWeight: FontWeight.w600, color: AppColors.ink),
                    ),
                  ),
                  TextButton(
                    onPressed: () => launchUrl(
                      Uri.parse(AppConfig.privacyPolicyUrl),
                      mode: LaunchMode.externalApplication,
                    ),
                    child: const Text('Política de privacidad'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
