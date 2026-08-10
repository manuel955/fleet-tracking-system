import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../services/passenger_service.dart';
import 'email_auth_screen.dart';
import '../theme/app_theme.dart';

class PassengerAccessScreen extends StatefulWidget {
  final ValueChanged<Map<String, dynamic>> onAuthorized;
  final Future<void> Function(Map<String, dynamic> session)?
  onEmailAuthenticated;

  const PassengerAccessScreen({
    super.key,
    required this.onAuthorized,
    this.onEmailAuthenticated,
  });

  @override
  State<PassengerAccessScreen> createState() => _PassengerAccessScreenState();
}

class _PassengerAccessScreenState extends State<PassengerAccessScreen> {
  final _codeController = TextEditingController();
  final _scannerController = MobileScannerController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _codeController.dispose();
    _scannerController.dispose();
    super.dispose();
  }

  Future<void> _redeem(String code) async {
    if (_busy || code.trim().isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final access = await PassengerService.redeemInvite(code);
      if (!mounted) return;
      widget.onAuthorized(access);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = error.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  Future<void> _manualCode() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          20,
          20,
          20 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Ingresar código',
              style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _codeController,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: 'Código del hotel',
                hintText: 'Pega el código del QR',
              ),
            ),
            const SizedBox(height: 14),
            ElevatedButton(
              onPressed: _busy
                  ? null
                  : () {
                      Navigator.of(context).pop();
                      _redeem(_codeController.text);
                    },
              child: const Text('Activar acceso'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _emailLogin() async {
    final callback = widget.onEmailAuthenticated;
    if (callback == null || !mounted) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => EmailAuthScreen(onAuthenticated: callback),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Acceso de huésped')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Row(
              children: [
                Image.asset(
                  'assets/branding/apl-mark.png',
                  width: 52,
                  height: 52,
                ),
                const SizedBox(width: 12),
                const Text(
                  'APL Logistics',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                ),
              ],
            ),
            const SizedBox(height: 26),
            const Text(
              'Activa tu acceso',
              style: TextStyle(fontSize: 27, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            const Text(
              'Escanea el código QR entregado por recepción para usar el servicio de movilidad.',
              style: TextStyle(color: Colors.black54, height: 1.35),
            ),
            const SizedBox(height: 20),
            ClipRRect(
              borderRadius: BorderRadius.circular(20),
              child: SizedBox(
                height: 320,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    MobileScanner(
                      controller: _scannerController,
                      onDetect: (capture) {
                        final value = capture.barcodes
                            .map((barcode) => barcode.rawValue)
                            .whereType<String>()
                            .firstWhere(
                              (value) => value.trim().isNotEmpty,
                              orElse: () => '',
                            );
                        if (value.isNotEmpty) _redeem(value);
                      },
                    ),
                    IgnorePointer(
                      child: Center(
                        child: Container(
                          width: 220,
                          height: 220,
                          decoration: BoxDecoration(
                            border: Border.all(color: AppColors.lime, width: 3),
                            borderRadius: BorderRadius.circular(20),
                          ),
                        ),
                      ),
                    ),
                    Positioned(
                      right: 12,
                      top: 12,
                      child: IconButton.filled(
                        onPressed: () => _scannerController.toggleTorch(),
                        icon: const Icon(Icons.flash_on),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _busy ? null : _manualCode,
              icon: const Icon(Icons.keyboard_outlined),
              label: const Text('Ingresar código manualmente'),
            ),
            if (widget.onEmailAuthenticated != null) ...[
              const SizedBox(height: 8),
              TextButton.icon(
                onPressed: _busy ? null : _emailLogin,
                icon: const Icon(Icons.email_outlined),
                label: const Text('Entrar con correo y contraseña'),
              ),
            ],
            if (_busy) ...[
              const SizedBox(height: 18),
              const Center(child: CircularProgressIndicator()),
            ],
            if (_error != null) ...[
              const SizedBox(height: 18),
              Text(_error!, style: TextStyle(color: Colors.red.shade700)),
            ],
            const SizedBox(height: 18),
            const Text(
              'Si no tienes un código, solicítalo en la recepción del hotel.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.black54, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}
