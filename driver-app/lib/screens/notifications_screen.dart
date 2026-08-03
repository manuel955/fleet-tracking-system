import 'dart:async';

import 'package:flutter/material.dart';
import '../services/notification_inbox_service.dart';
import '../theme/app_theme.dart';

class DriverNotificationsScreen extends StatefulWidget {
  const DriverNotificationsScreen({super.key});

  @override
  State<DriverNotificationsScreen> createState() =>
      _DriverNotificationsScreenState();
}

class _DriverNotificationsScreenState extends State<DriverNotificationsScreen> {
  static const _fieldLabels = {
    'profile': 'Foto de perfil',
    'dni': 'DNI',
    'license': 'Licencia',
    'soat': 'SOAT',
    'circulationCard': 'Tarjeta de circulación',
    'technicalReview': 'Revisión técnica',
    'criminalRecord': 'Récord del conductor',
    'workCertificate': 'Certificado laboral',
  };

  List<Map<String, dynamic>> _items = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final items = await NotificationInboxService.read();
    await NotificationInboxService.markAllRead();
    if (!mounted) return;
    setState(() {
      _items = items;
      _loading = false;
    });
  }

  List<String> _labelsFor(Map<String, dynamic> item) {
    return (item['rejectionFieldKeys']?.toString() ?? '')
        .split(',')
        .map((key) => _fieldLabels[key.trim()])
        .whereType<String>()
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Notificaciones')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _items.isEmpty
              ? const Center(
                  child: Padding(
                    padding: EdgeInsets.all(28),
                    child: Text(
                      'Aún no tienes notificaciones.',
                      textAlign: TextAlign.center,
                    ),
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: _items.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 12),
                  itemBuilder: (context, index) {
                    final item = _items[index];
                    final rejected = item['status'] == 'rejected';
                    final labels = _labelsFor(item);
                    return Card(
                      elevation: 0,
                      color:
                          rejected
                              ? AppColors.red.withValues(alpha: .10)
                              : AppColors.green.withValues(alpha: .10),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16),
                        side: BorderSide(
                          color: rejected
                              ? AppColors.red.withValues(alpha: .35)
                              : AppColors.green.withValues(alpha: .35),
                        ),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Icon(
                                  rejected
                                      ? Icons.error_outline
                                      : Icons.check_circle_outline,
                                  color: rejected
                                      ? AppColors.red
                                      : AppColors.green,
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Text(
                                    item['title']?.toString() ?? 'Aviso',
                                    style: const TextStyle(
                                      fontSize: 16,
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 10),
                            Text(item['body']?.toString() ?? ''),
                            if (rejected && labels.isNotEmpty) ...[
                              const SizedBox(height: 10),
                              Text(
                                'Debes corregir: ${labels.join(', ')}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w600),
                              ),
                            ],
                            if (rejected) ...[
                              const SizedBox(height: 14),
                              SizedBox(
                                width: double.infinity,
                                child: ElevatedButton.icon(
                                  onPressed: () => Navigator.pop(context, true),
                                  icon: const Icon(Icons.upload_file),
                                  label: const Text('Corregir documentos'),
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    );
                  },
                ),
    );
  }
}

class NotificationBellButton extends StatefulWidget {
  final bool floating;
  final VoidCallback? onCorrect;

  const NotificationBellButton({
    super.key,
    this.floating = false,
    this.onCorrect,
  });

  @override
  State<NotificationBellButton> createState() => _NotificationBellButtonState();
}

class _NotificationBellButtonState extends State<NotificationBellButton> {
  int _unread = 0;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _loadUnread();
    _refreshTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _loadUnread(),
    );
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadUnread() async {
    final unread = await NotificationInboxService.unreadCount();
    if (mounted) setState(() => _unread = unread);
  }

  Future<void> _open() async {
    final correct = await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (_) => const DriverNotificationsScreen()),
    );
    if (correct == true) widget.onCorrect?.call();
    _loadUnread();
  }

  @override
  Widget build(BuildContext context) {
    final button = Stack(
      clipBehavior: Clip.none,
      children: [
        IconButton(
          icon: const Icon(Icons.notifications_outlined),
          tooltip: 'Notificaciones',
          onPressed: _open,
        ),
        if (_unread > 0)
          Positioned(
            right: 5,
            top: 2,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
              decoration: const BoxDecoration(
                color: AppColors.red,
                shape: BoxShape.circle,
              ),
              child: Text(
                _unread > 9 ? '9+' : '$_unread',
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          ),
      ],
    );

    if (!widget.floating) return button;
    return Material(
      color: Colors.white,
      shape: const CircleBorder(),
      elevation: 3,
      child: button,
    );
  }
}
