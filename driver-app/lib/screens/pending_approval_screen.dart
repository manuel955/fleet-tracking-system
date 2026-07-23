import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../services/driver_profile_service.dart';
import '../widgets/document_upload_tile.dart';

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
  final Map<String, PickedDocument> _documents = {};

  static const _docs = [
    ('profile', 'Foto de perfil', false, 'profilePhotoUrl'),
    ('dni', 'DNI', true, 'dniDocUrl'),
    ('license', 'Licencia de conducir', true, 'licenseDocUrl'),
    ('soat', 'SOAT', true, 'soatDocUrl'),
    ('circulationCard', 'Tarjeta única de circulación', true, 'circulationCardDocUrl'),
    ('technicalReview', 'Revisión técnica vehicular', true, 'technicalReviewDocUrl'),
    ('criminalRecord', 'Récord del conductor', true, 'criminalRecordDocUrl'),
    ('workCertificate', 'Certificado único laboral', true, 'workCertificateDocUrl'),
  ];

  Future<void> _submitResubmission() async {
    if (_documents.isEmpty) {
      setState(() => _error = 'Sube al menos un documento para volver a enviarlo.');
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
    final status = widget.profile['approvalStatus'] as String? ?? 'pending_review';
    final rejected = status == 'rejected';
    final reason = widget.profile['rejectionReason'] as String?;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Estado de tu registro'),
        automaticallyImplyLeading: false,
        actions: [
          IconButton(icon: const Icon(Icons.logout), tooltip: 'Cerrar sesión', onPressed: _logout),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Icon(
              rejected ? Icons.error_outline : Icons.hourglass_top,
              size: 56,
              color: rejected ? Colors.red : Colors.orange,
            ),
            const SizedBox(height: 16),
            Text(
              rejected ? 'Tu registro fue rechazado' : 'Tu registro está en revisión',
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Text(
              rejected
                  ? 'Corrige lo indicado y vuelve a subir los documentos necesarios.'
                  : 'Un administrador está revisando tus documentos. Te avisaremos cuando puedas empezar a trabajar.',
              style: const TextStyle(color: Colors.black54),
            ),
            if (rejected && reason != null && reason.isNotEmpty) ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.red.shade50,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: Colors.red.shade200),
                ),
                child: Text('Motivo: $reason', style: TextStyle(color: Colors.red.shade900)),
              ),
            ],
            if (rejected) ...[
              const SizedBox(height: 20),
              if (!_resubmitting)
                ElevatedButton(
                  onPressed: () => setState(() => _resubmitting = true),
                  style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                  child: const Text('Volver a subir documentos'),
                )
              else ...[
                const Text(
                  'Sube de nuevo los documentos que necesitan corrección:',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
                ..._docs.map(
                  (d) => DocumentUploadTile(
                    label: d.$2,
                    allowPdf: d.$3,
                    existingUrl: widget.profile[d.$4] as String?,
                    onChanged: (file) {
                      if (file != null) {
                        _documents[d.$1] = file;
                      } else {
                        _documents.remove(d.$1);
                      }
                    },
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: const TextStyle(color: Colors.red)),
                ],
                const SizedBox(height: 16),
                ElevatedButton(
                  onPressed: _busy ? null : _submitResubmission,
                  style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                  child: _busy
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
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
