import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../services/driver_profile_service.dart';
import '../theme/app_theme.dart';
import '../widgets/document_upload_tile.dart';
import 'notifications_screen.dart';

/// Se muestra mientras `approvalStatus` sigue en 'pending_review', o si fue
/// 'rejected' (con motivo de texto libre escrito por el admin desde el
/// dashboard). Si fue rechazado, el conductor puede volver a subir solo los
/// documentos que necesiten corregirse, sin repetir el registro completo.
class PendingApprovalScreen extends StatefulWidget {
  final Map<String, dynamic> profile;
  final VoidCallback onLoggedOut;
  final VoidCallback onResubmitted;

  const PendingApprovalScreen({
    super.key,
    required this.profile,
    required this.onLoggedOut,
    required this.onResubmitted,
  });

  @override
  State<PendingApprovalScreen> createState() => _PendingApprovalScreenState();
}

class _PendingApprovalScreenState extends State<PendingApprovalScreen> {
  bool _resubmitting = false;
  bool _busy = false;
  String? _error;
  final Map<String, List<PickedDocument>> _documents = {};

  static const _docs = [
    ('profile', 'Foto de perfil', false, ['profilePhotoUrl']),
    (
      'dni',
      'DNI (2 fotos o 1 PDF)',
      true,
      ['dniDocUrl', 'dniFrontDocUrl', 'dniBackDocUrl']
    ),
    ('license', 'Licencia de conducir', true, ['licenseDocUrl']),
    ('soat', 'SOAT', true, ['soatDocUrl']),
    (
      'circulationCard',
      'Tarjeta única de circulación',
      true,
      ['circulationCardDocUrl']
    ),
    (
      'technicalReview',
      'Revisión técnica vehicular',
      true,
      ['technicalReviewDocUrl']
    ),
    ('criminalRecord', 'Récord del conductor', true, ['criminalRecordDocUrl']),
    (
      'workCertificate',
      'Certificado único laboral',
      true,
      ['workCertificateDocUrl']
    ),
  ];

  Set<String> get _rejectedDocumentKeys {
    final raw = widget.profile['rejectionFieldKeys']?.toString() ?? '';
    return raw
        .split(',')
        .map((key) => key.trim())
        .where((key) => key.isNotEmpty)
        .toSet();
  }

  Iterable<dynamic> get _visibleDocs {
    final keys = _rejectedDocumentKeys;
    if (keys.isEmpty) return _docs;
    return _docs.where((document) => keys.contains(document.$1));
  }

  String get _visibleDocumentLabels =>
      _visibleDocs.map((document) => document.$2).join(', ');

  bool get _isDniSelectionValid {
    final dni = _documents['dni'] ?? const <PickedDocument>[];
    if (dni.isEmpty) return true;
    if (dni.length == 1) return dni.single.extension == 'pdf';
    return dni.length == 2 && dni.every((file) => file.extension != 'pdf');
  }

  Future<void> _submitResubmission() async {
    if (_documents.isEmpty) {
      setState(
          () => _error = 'Sube al menos un documento para volver a enviarlo.');
      return;
    }
    if (!_isDniSelectionValid) {
      setState(() => _error = 'El DNI requiere 2 fotos o 1 solo PDF.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await DriverProfileService.resubmitDocuments(_documents);
      widget.onResubmitted();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  Future<void> _logout() async {
    await AuthService.logout();
    widget.onLoggedOut();
  }

  @override
  Widget build(BuildContext context) {
    final status =
        widget.profile['approvalStatus'] as String? ?? 'pending_review';
    final rejected = status == 'rejected';
    final reason = widget.profile['rejectionReason'] as String?;

    return Scaffold(
      appBar: AppBar(
        title: Text(rejected ? 'Registro rechazado' : 'Registro enviado'),
        automaticallyImplyLeading: false,
        actions: [
          NotificationBellButton(
            onCorrect: () => setState(() => _resubmitting = true),
          ),
          IconButton(
              icon: const Icon(Icons.logout),
              tooltip: 'Cerrar sesión',
              onPressed: _logout),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Icon(
              rejected ? Icons.error_outline : Icons.hourglass_top,
              size: 56,
              color: rejected ? AppColors.red : AppColors.amber,
            ),
            const SizedBox(height: 16),
            Text(
              rejected
                  ? 'Tu registro fue rechazado'
                  : 'Tu registro está en revisión',
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Text(
              rejected
                  ? 'Corrige lo indicado y vuelve a subir los documentos necesarios. Mientras tu registro estÃ© rechazado no puedes conectarte, enviar ubicaciÃ³n ni recibir viajes.'
                  : 'Un administrador está revisando tus documentos. Te avisaremos cuando puedas empezar a trabajar.',
              style: const TextStyle(color: AppColors.muted),
            ),
            if (rejected && reason != null && reason.isNotEmpty) ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.red.withValues(alpha: .10),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.red.withValues(alpha: .35)),
                ),
                child: Text('Motivo: $reason',
                    style: const TextStyle(color: AppColors.red)),
              ),
            ],
            if (rejected && _rejectedDocumentKeys.isNotEmpty) ...[
              const SizedBox(height: 12),
              Text(
                'Documentos que debes corregir: $_visibleDocumentLabels',
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ],
            if (rejected) ...[
              const SizedBox(height: 20),
              if (!_resubmitting)
                ElevatedButton(
                  onPressed: () => setState(() => _resubmitting = true),
                  style: ElevatedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48)),
                  child: const Text('Volver a subir documentos'),
                )
              else ...[
                const Text(
                  'Sube de nuevo los documentos que necesitan corrección:',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
                ..._visibleDocs.map(
                  (d) => DocumentUploadTile(
                    key: ValueKey(d.$1),
                    label: d.$2,
                    allowPdf: d.$3,
                    dniMode: d.$1 == 'dni',
                    files: _documents[d.$1] ?? const <PickedDocument>[],
                    existingUrls: [
                      for (final field in d.$4)
                        if ((widget.profile[field]?.toString() ?? '')
                            .isNotEmpty)
                          widget.profile[field].toString(),
                    ],
                    onChanged: (files) {
                      setState(() {
                        if (files.isNotEmpty) {
                          _documents[d.$1] = files;
                        } else {
                          _documents.remove(d.$1);
                        }
                      });
                    },
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: const TextStyle(color: AppColors.red)),
                ],
                const SizedBox(height: 16),
                ElevatedButton(
                  onPressed: _busy ? null : _submitResubmission,
                  style: ElevatedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48)),
                  child: _busy
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white),
                        )
                      : const Text('Enviar de nuevo'),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}
