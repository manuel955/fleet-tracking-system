import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../services/passenger_service.dart';
import '../theme/app_theme.dart';

/// Pestaña "Cuenta": datos del perfil del pasajero.
class AccountTabScreen extends StatefulWidget {
  final VoidCallback onLoggedOut;

  const AccountTabScreen({super.key, required this.onLoggedOut});

  @override
  State<AccountTabScreen> createState() => _AccountTabScreenState();
}

class _AccountTabScreenState extends State<AccountTabScreen> {
  Map<String, String>? _profile;
  String _versionLabel = '';

  @override
  void initState() {
    super.initState();
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

  Future<void> _logout() async {
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
                      style: TextStyle(
                        fontSize: 14,
                        color: AppColors.muted,
                      ),
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
            leading: const Icon(Icons.logout, color: AppColors.red),
            title: const Text(
              'Cerrar sesión',
              style: TextStyle(color: AppColors.red),
            ),
            onTap: _logout,
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
