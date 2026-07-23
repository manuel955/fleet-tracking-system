import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../services/driver_profile_service.dart';

/// Tile reusable para elegir un documento (foto o PDF), usado en el
/// registro y en la resubida de documentos tras un rechazo.
/// `allowPdf: false` lo deja solo con camara/galeria (foto de perfil).
class DocumentUploadTile extends StatefulWidget {
  final String label;
  final bool allowPdf;
  final String? existingUrl;
  final ValueChanged<PickedDocument?> onChanged;

  const DocumentUploadTile({
    super.key,
    required this.label,
    required this.onChanged,
    this.allowPdf = true,
    this.existingUrl,
  });

  @override
  State<DocumentUploadTile> createState() => _DocumentUploadTileState();
}

class _DocumentUploadTileState extends State<DocumentUploadTile> {
  String? _pickedLabel;

  Future<void> _pickImage(ImageSource source) async {
    final picked = await ImagePicker().pickImage(source: source, imageQuality: 80, maxWidth: 1600);
    if (picked == null) return;
    final bytes = await File(picked.path).readAsBytes();
    _apply(
      PickedDocument(bytes: bytes, extension: 'jpg', contentType: 'image/jpeg'),
      source == ImageSource.camera ? 'Foto tomada' : 'Foto elegida de la galería',
    );
  }

  Future<void> _pickPdf() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['pdf'],
    );
    final file = result?.files.single;
    if (file == null || file.path == null) return;
    final bytes = await File(file.path!).readAsBytes();
    _apply(PickedDocument(bytes: bytes, extension: 'pdf', contentType: 'application/pdf'), file.name);
  }

  void _apply(PickedDocument file, String label) {
    setState(() => _pickedLabel = label);
    widget.onChanged(file);
  }

  @override
  Widget build(BuildContext context) {
    final hasFile = _pickedLabel != null;
    final hasExisting = !hasFile && (widget.existingUrl?.isNotEmpty ?? false);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          border: Border.all(color: Colors.black12),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(widget.label, style: const TextStyle(fontWeight: FontWeight.w600)),
                ),
                if (hasFile)
                  const Icon(Icons.check_circle, color: Colors.green, size: 20)
                else if (hasExisting)
                  const Icon(Icons.check_circle_outline, color: Colors.grey, size: 20),
              ],
            ),
            if (hasFile) ...[
              const SizedBox(height: 4),
              Text(_pickedLabel!, style: const TextStyle(color: Colors.grey, fontSize: 12)),
            ] else if (hasExisting) ...[
              const SizedBox(height: 4),
              const Text(
                'Ya tienes un archivo subido. Solo vuelve a subir si quieres reemplazarlo.',
                style: TextStyle(color: Colors.grey, fontSize: 12),
              ),
            ],
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: () => _pickImage(ImageSource.camera),
                  icon: const Icon(Icons.camera_alt, size: 18),
                  label: const Text('Tomar foto'),
                ),
                OutlinedButton.icon(
                  onPressed: () => _pickImage(ImageSource.gallery),
                  icon: const Icon(Icons.photo_library, size: 18),
                  label: const Text('Galería'),
                ),
                if (widget.allowPdf)
                  OutlinedButton.icon(
                    onPressed: _pickPdf,
                    icon: const Icon(Icons.picture_as_pdf, size: 18),
                    label: const Text('Elegir PDF'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
