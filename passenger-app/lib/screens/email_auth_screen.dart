import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../services/vps_api_client.dart';
import '../theme/app_theme.dart';

class EmailAuthScreen extends StatefulWidget {
  const EmailAuthScreen({super.key, required this.onAuthenticated});

  final Future<void> Function(Map<String, dynamic> session) onAuthenticated;

  @override
  State<EmailAuthScreen> createState() => _EmailAuthScreenState();
}

class _EmailAuthScreenState extends State<EmailAuthScreen> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _busy = false;
  String? _error;
  String? _notice;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  String _friendlyError(Object error) {
    if (error is VpsApiException &&
        (error.statusCode == 401 || error.statusCode == 403)) {
      return 'Usuario no registrado o pendiente de aprobación.';
    }
    if (error is VpsApiException && error.statusCode >= 500) {
      return 'No se pudo conectar con el servicio. Intenta nuevamente.';
    }
    if (error is FirebaseAuthException) {
      switch (error.code) {
        case 'invalid-credential':
        case 'wrong-password':
        case 'user-not-found':
          return 'El correo o la contraseña no son correctos.';
        case 'invalid-email':
          return 'Escribe un correo válido.';
        case 'user-disabled':
          return 'Esta cuenta está desactivada.';
        case 'operation-not-allowed':
          return 'El acceso por correo todavía no está habilitado.';
        default:
          return error.message ?? 'No se pudo iniciar sesión.';
      }
    }
    return error.toString().replaceFirst('Exception: ', '');
  }

  Future<void> _submit() async {
    final email = _emailController.text.trim();
    final password = _passwordController.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _error = 'Completa correo y contraseña.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final session = await AuthService.signInWithEmailPassword(
        email: email,
        password: password,
      );
      await widget.onAuthenticated(session);
      if (mounted) Navigator.of(context).pop();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _friendlyError(error);
      });
    }
  }

  Future<void> _resetPassword() async {
    final email = _emailController.text.trim();
    if (email.isEmpty) {
      setState(() {
        _error = 'Escribe primero tu correo.';
        _notice = null;
      });
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      await AuthService.sendPasswordResetEmail(email);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _notice = 'Revisa tu correo para crear una contraseña nueva.';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _friendlyError(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Acceso de pasajero')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const Icon(Icons.email_outlined, size: 54, color: AppColors.ink),
            const SizedBox(height: 18),
            const Text(
              'Inicia sesión',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 27, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 10),
            const Text(
              'Usa el correo y la contraseña que vinculaste a tu cuenta.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.black54, height: 1.35),
            ),
            const SizedBox(height: 28),
            TextField(
              controller: _emailController,
              enabled: !_busy,
              keyboardType: TextInputType.emailAddress,
              autofillHints: const [AutofillHints.email],
              decoration: const InputDecoration(
                labelText: 'Correo electrónico',
                prefixIcon: Icon(Icons.email_outlined),
              ),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _passwordController,
              enabled: !_busy,
              obscureText: true,
              autofillHints: const [AutofillHints.password],
              decoration: const InputDecoration(
                labelText: 'Contraseña',
                prefixIcon: Icon(Icons.lock_outline),
              ),
              onSubmitted: (_) => _submit(),
            ),
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? 'Verificando...' : 'Entrar'),
            ),
            TextButton(
              onPressed: _busy ? null : _resetPassword,
              child: const Text('Olvidé mi contraseña'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 18),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.red.shade700),
              ),
            ],
            if (_notice != null) ...[
              const SizedBox(height: 18),
              Text(
                _notice!,
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.green.shade700),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
