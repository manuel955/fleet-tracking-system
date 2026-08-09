import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config.dart';
import '../services/auth_service.dart';
import '../services/passenger_service.dart';
import 'phone_auth_screen.dart';
import '../theme/app_theme.dart';

/// Pestaña "Cuenta": datos del perfil del pasajero.
class AccountTabScreen extends StatefulWidget {
  final VoidCallback onLoggedOut;
  final Future<void> Function(Map<String, dynamic> session)
  onPhoneAuthenticated;

  const AccountTabScreen({
    super.key,
    required this.onLoggedOut,
    required this.onPhoneAuthenticated,
  });

  @override
  State<AccountTabScreen> createState() => _AccountTabScreenState();
}

class _AccountTabScreenState extends State<AccountTabScreen> {
  Map<String, String>? _profile;
  String _versionLabel = '';
  bool _deleting = false;
  bool _hasPhoneSession = false;

  @override
  void initState() {
    super.initState();
    _hasPhoneSession = AuthService.hasPhoneSession;
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

  Future<void> _linkPhone() async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => PhoneAuthScreen(
          initialPhone: _profile?['phone'],
          onAuthenticated: widget.onPhoneAuthenticated,
        ),
      ),
    );
    if (mounted) setState(() => _hasPhoneSession = AuthService.hasPhoneSession);
  }

  Future<void> _logout() async {
    if (!_hasPhoneSession) {
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Vincula tu teléfono primero'),
          content: const Text(
            'Para no perder tu cuenta, verifica tu número de teléfono antes de cerrar sesión. Después podrás volver a entrar con un código SMS.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Entendido'),
            ),
            ElevatedButton(
              onPressed: () {
                Navigator.pop(context);
                _linkPhone();
              },
              child: const Text('Vincular teléfono'),
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
          '¿Seguro que quieres cerrar sesión? Vas a tener que registrarte de nuevo.',
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
              _hasPhoneSession
                  ? Icons.verified_user_outlined
                  : Icons.phone_outlined,
              color: _hasPhoneSession ? Colors.green : AppColors.ink,
            ),
            title: Text(
              _hasPhoneSession
                  ? 'Acceso recuperable activado'
                  : 'Vincular teléfono para recuperar acceso',
            ),
            subtitle: Text(
              _hasPhoneSession
                  ? 'Podrás volver a entrar con un código SMS.'
                  : 'Necesario antes de cerrar sesión.',
            ),
            onTap: _hasPhoneSession ? null : _linkPhone,
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
