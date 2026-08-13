import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config.dart';
import '../services/auth_service.dart';
import '../services/passenger_service.dart';
import 'email_auth_screen.dart';
import 'email_link_screen.dart';
import '../theme/app_theme.dart';

/// Pestaña "Cuenta": datos del perfil del pasajero.
class AccountTabScreen extends StatefulWidget {
  final VoidCallback onLoggedOut;
  final Future<void> Function(Map<String, dynamic> session)
  onEmailAuthenticated;

  const AccountTabScreen({
    super.key,
    required this.onLoggedOut,
    required this.onEmailAuthenticated,
  });

  @override
  State<AccountTabScreen> createState() => _AccountTabScreenState();
}

class _AccountTabScreenState extends State<AccountTabScreen> {
  Map<String, String>? _profile;
  String _versionLabel = '';
  bool _deleting = false;
  bool _hasEmailSession = false;
  String? _accountEmail;

  @override
  void initState() {
    super.initState();
    _hasEmailSession = AuthService.hasEmailSession;
    _accountEmail = AuthService.currentEmail;
    _load();
    _loadAppVersion();
  }

  Future<void> _load() async {
    final profile = await PassengerService.cachedProfile();
    if (mounted) setState(() => _profile = profile);
  }

  Future<void> _loadAppVersion() async {
    final info = await PackageInfo.fromPlatform();
    if (mounted) {
      setState(
        () => _versionLabel = 'Versión ${info.version} (${info.buildNumber})',
      );
    }
  }

  Future<void> _linkEmail() async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) =>
            EmailLinkScreen(onAuthenticated: widget.onEmailAuthenticated),
      ),
    );
    if (mounted) {
      setState(() {
        _hasEmailSession = AuthService.hasEmailSession;
        _accountEmail = AuthService.currentEmail;
      });
    }
  }

  Future<void> _loginExistingEmail() async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) =>
            EmailAuthScreen(onAuthenticated: widget.onEmailAuthenticated),
      ),
    );
    if (mounted) {
      setState(() {
        _hasEmailSession = AuthService.hasEmailSession;
        _accountEmail = AuthService.currentEmail;
      });
    }
  }

  Future<void> _logout() async {
    if (!_hasEmailSession) {
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Vincula tu correo primero'),
          content: const Text(
            'Para no perder tu cuenta, crea un acceso con correo y contraseña antes de cerrar sesión.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Entendido'),
            ),
            ElevatedButton(
              onPressed: () {
                Navigator.pop(context);
                _linkEmail();
              },
              child: const Text('Vincular correo'),
            ),
          ],
        ),
      );
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Cerrar sesión'),
        content: const Text(
          '¿Seguro que quieres cerrar sesión? Podrás volver a entrar con tu correo y contraseña.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text(
              'Cerrar sesión',
              style: TextStyle(color: AppColors.red),
            ),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await PassengerService.logout();
      widget.onLoggedOut();
    }
  }

  Future<void> _openUrl(String url) async {
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  }

  Future<void> _deleteAccount() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Eliminar cuenta y datos'),
        content: const Text(
          'Se eliminarán tu perfil, foto de credencial, ubicación y registros de viajes identificables. Esta acción no se puede deshacer.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text(
              'Eliminar todo',
              style: TextStyle(color: AppColors.red),
            ),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _deleting = true);
    try {
      await PassengerService.deleteAccount();
      widget.onLoggedOut();
    } catch (error) {
      if (!mounted) return;
      setState(() => _deleting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(error.toString().replaceFirst('Exception: ', '')),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final name = _profile?['name'] ?? '-';
    final phone = _profile?['phone'] ?? '-';
    final initial = name.isNotEmpty ? name[0].toUpperCase() : '?';

    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
        children: [
          const Text(
            'Cuenta',
            style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 24),
          Row(
            children: [
              CircleAvatar(
                radius: 32,
                backgroundColor: AppColors.ink,
                child: Text(
                  initial,
                  style: const TextStyle(
                    color: AppColors.paper,
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      phone,
                      style: TextStyle(fontSize: 14, color: AppColors.muted),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 32),
          const Divider(),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.badge_outlined),
            title: const Text('Nombre'),
            subtitle: Text(name),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.phone_outlined),
            title: const Text('Teléfono'),
            subtitle: Text(phone),
          ),
          const SizedBox(height: 24),
          const Divider(),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(
              _hasEmailSession
                  ? Icons.verified_user_outlined
                  : Icons.email_outlined,
              color: _hasEmailSession ? Colors.green : AppColors.ink,
            ),
            title: Text(
              _hasEmailSession
                  ? 'Acceso recuperable activado'
                  : 'Vincular correo para recuperar acceso',
            ),
            subtitle: Text(
              _hasEmailSession
                  ? (_accountEmail ?? 'Podrás iniciar sesión con tu correo.')
                  : 'Sin SMS. Necesario antes de cerrar sesión.',
            ),
            onTap: _hasEmailSession ? null : _linkEmail,
          ),
          if (!_hasEmailSession)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.login_outlined),
              title: const Text('Ingresar a una cuenta existente'),
              subtitle: const Text(
                'Usa el correo y la contraseÃ±a de otra cuenta de pasajero.',
              ),
              onTap: _loginExistingEmail,
            ),
          const SizedBox(height: 8),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.logout, color: AppColors.red),
            title: const Text(
              'Cerrar sesión',
              style: TextStyle(color: AppColors.red),
            ),
            onTap: _logout,
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            enabled: !_deleting,
            leading: const Icon(
              Icons.delete_forever_outlined,
              color: AppColors.red,
            ),
            title: const Text(
              'Eliminar cuenta y datos',
              style: TextStyle(color: AppColors.red),
            ),
            subtitle: const Text(
              'Borra permanentemente la información asociada',
            ),
            onTap: _deleteAccount,
          ),
          const Divider(),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.privacy_tip_outlined),
            title: const Text('Política de privacidad'),
            onTap: () => _openUrl(AppConfig.privacyPolicyUrl),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.open_in_new),
            title: const Text('Solicitar eliminación por web'),
            onTap: () => _openUrl(AppConfig.deleteAccountUrl),
          ),
          if (_versionLabel.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                _versionLabel,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 12, color: AppColors.muted),
              ),
            ),
        ],
      ),
    );
  }
}
