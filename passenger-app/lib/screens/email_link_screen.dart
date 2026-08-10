import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/auth_service.dart';
import '../theme/app_theme.dart';

/// Convierte la sesión temporal del pasajero en una cuenta recuperable por
/// correo y contraseña. El número telefónico permanece solo como contacto.
class EmailLinkScreen extends StatefulWidget {
  const EmailLinkScreen({super.key, required this.onAuthenticated});

  final Future<void> Function(Map<String, dynamic> session) onAuthenticated;

  @override
  State<EmailLinkScreen> createState() => _EmailLinkScreenState();
}

class _EmailLinkScreenState extends State<EmailLinkScreen> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmationController = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _confirmationController.dispose();
    super.dispose();
  }

  String _friendlyError(Object error) {
    if (error is FirebaseAuthException) {
      switch (error.code) {
        case 'email-already-in-use':
          return 'Ese correo ya está registrado. Cierra esta pantalla e inicia sesión con esa cuenta.';
        case 'invalid-email':
          return 'Escribe un correo válido.';
        case 'weak-password':
          return 'Usa una contraseña de al menos 8 caracteres.';
        case 'provider-already-linked':
          return 'Esta cuenta ya tiene un correo vinculado.';
        case 'requires-recent-login':
          return 'La sesión venció. Vuelve a abrir la app e inténtalo nuevamente.';
        default:
          return error.message ?? 'No se pudo vincular el correo.';
      }
    }
    return error.toString().replaceFirst('Exception: ', '');
  }

  Future<void> _submit() async {
    final email = _emailController.text.trim();
    final password = _passwordController.text;
    final confirmation = _confirmationController.text;
    if (email.isEmpty || password.isEmpty || confirmation.isEmpty) {
      setState(() => _error = 'Completa correo y contraseña.');
      return;
    }
    if (password.length < 8) {
      setState(
        () => _error = 'La contraseña debe tener al menos 8 caracteres.',
      );
      return;
    }
    if (password != confirmation) {
      setState(() => _error = 'Las contraseñas no coinciden.');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final session = await AuthService.linkWithEmailPassword(
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Proteger mi cuenta')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const Icon(
              Icons.mark_email_read_outlined,
              size: 54,
              color: AppColors.ink,
            ),
            const SizedBox(height: 18),
            const Text(
              'Vincula un correo',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 27, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 10),
            const Text(
              'Así podrás recuperar tu cuenta e iniciar sesión sin códigos SMS. Tu teléfono seguirá guardado únicamente como dato de contacto.',
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
              autofillHints: const [AutofillHints.newPassword],
              decoration: const InputDecoration(
                labelText: 'Contraseña',
                helperText: 'Mínimo 8 caracteres',
                prefixIcon: Icon(Icons.lock_outline),
              ),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _confirmationController,
              enabled: !_busy,
              obscureText: true,
              autofillHints: const [AutofillHints.newPassword],
              decoration: const InputDecoration(
                labelText: 'Confirmar contraseña',
                prefixIcon: Icon(Icons.lock_reset_outlined),
              ),
              onSubmitted: (_) => _submit(),
            ),
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? 'Guardando...' : 'Vincular correo'),
            ),
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
