import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../services/driver_profile_service.dart';

/// Selector controlado por la pantalla que lo contiene. La lista de archivos
/// vive en el formulario padre para que el check y la vista previa no se
/// pierdan cuando Flutter reconstruye la pantalla.
class DocumentUploadTile extends StatelessWidget {
  static const int _maxDocumentBytes = 8 * 1024 * 1024;
  final String label;
  final bool allowPdf;
  final bool dniMode;
  final List<PickedDocument> files;
  final List<String> existingUrls;
  final ValueChanged<List<PickedDocument>> onChanged;

  const DocumentUploadTile({
    super.key,
    required this.label,
    required this.onChanged,
    this.allowPdf = true,
    this.dniMode = false,
    this.files = const [],
    this.existingUrls = const [],
  });

  Future<void> _pickImage(BuildContext context, ImageSource source) async {
    final picked = await ImagePicker().pickImage(
      source: source,
      imageQuality: 80,
      maxWidth: 1600,
    );
    if (picked == null) return;
    final size = await File(picked.path).length();
    if (size > _maxDocumentBytes) {
      if (context.mounted) {
        _showMessage(context, 'El archivo no debe superar 8 MB.');
      }
      return;
    }
    final bytes = await File(picked.path).readAsBytes();
    if (!context.mounted) return;
    final file = PickedDocument(
      bytes: bytes,
      extension: 'jpg',
      contentType: 'image/jpeg',
      displayName:
          source == ImageSource.camera ? 'Foto tomada' : 'Foto de galería',
    );
    _addFile(context, file);
  }

  Future<void> _pickPdf(BuildContext context) async {
    final result = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['pdf'],
    );
    final file = result?.files.single;
    if (file == null || file.path == null) return;
    final size = file.size;
    if (size > _maxDocumentBytes) {
      if (context.mounted) {
        _showMessage(context, 'El archivo no debe superar 8 MB.');
      }
      return;
    }
    final bytes = await File(file.path!).readAsBytes();
    if (!context.mounted) return;
    _addFile(
      context,
      PickedDocument(
        bytes: bytes,
        extension: 'pdf',
        contentType: 'application/pdf',
        displayName: file.name,
      ),
    );
  }

  void _addFile(BuildContext context, PickedDocument file) {
    if (!dniMode) {
      onChanged([file]);
      return;
    }

    final hasPdf = files.any((item) => item.extension == 'pdf');
    final imageCount = files.where((item) => item.extension != 'pdf').length;
    if (file.extension == 'pdf') {
      if (imageCount > 0 || hasPdf) {
        _showMessage(context, 'Para el DNI elige 2 fotos o 1 PDF, no ambos.');
        return;
      }
      onChanged([file]);
      return;
    }

    if (hasPdf || imageCount >= 2) {
      _showMessage(context, 'El DNI admite como máximo 2 fotos.');
      return;
    }
    onChanged([...files, file]);
  }

  void _showMessage(BuildContext context, String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  void _removeFile(int index) {
    final next = [...files]..removeAt(index);
    onChanged(next);
  }

  bool get _hasPdf => files.any((file) => file.extension == 'pdf');
  int get _imageCount => files.where((file) => file.extension != 'pdf').length;

  @override
  Widget build(BuildContext context) {
    final hasSelection = files.isNotEmpty;
    final hasExisting = !hasSelection && existingUrls.isNotEmpty;
    final canTakePhoto = !dniMode || (!_hasPdf && _imageCount < 2);
    final canChoosePdf =
        allowPdf && (!dniMode || (!_hasPdf && _imageCount == 0));

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
                  child: Text(
                    label,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                if (hasSelection)
                  const Icon(Icons.check_circle, color: Colors.green, size: 20)
                else if (hasExisting)
                  const Icon(Icons.check_circle_outline,
                      color: Colors.grey, size: 20),
              ],
            ),
            if (dniMode && hasSelection) ...[
              const SizedBox(height: 4),
              Text(
                _hasPdf
                    ? '1 PDF seleccionado'
                    : '$_imageCount de 2 fotos seleccionadas',
                style: TextStyle(
                  color: _hasPdf || _imageCount == 2
                      ? Colors.green.shade700
                      : Colors.orange.shade800,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
            if (hasExisting) ...[
              const SizedBox(height: 4),
              const Text(
                'Documento guardado. Puedes reemplazarlo antes de enviar.',
                style: TextStyle(color: Colors.grey, fontSize: 12),
              ),
            ],
            if (hasSelection) ...[
              const SizedBox(height: 10),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  for (var index = 0; index < files.length; index++)
                    _selectedPreview(context, files[index], index),
                ],
              ),
            ] else if (hasExisting) ...[
              const SizedBox(height: 10),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  for (final url in existingUrls) _existingPreview(url),
                ],
              ),
            ],
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: canTakePhoto
                      ? () => _pickImage(context, ImageSource.camera)
                      : null,
                  icon: const Icon(Icons.camera_alt, size: 18),
                  label: const Text('Tomar foto'),
                ),
                OutlinedButton.icon(
                  onPressed: canTakePhoto
                      ? () => _pickImage(context, ImageSource.gallery)
                      : null,
                  icon: const Icon(Icons.photo_library, size: 18),
                  label: const Text('Galería'),
                ),
                if (allowPdf)
                  OutlinedButton.icon(
                    onPressed: canChoosePdf ? () => _pickPdf(context) : null,
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

  Widget _selectedPreview(
      BuildContext context, PickedDocument file, int index) {
    final isImage = file.contentType.startsWith('image/');
    return Stack(
      children: [
        Container(
          width: 112,
          height: 112,
          decoration: BoxDecoration(
            color: Colors.grey.shade100,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: Colors.black12),
          ),
          clipBehavior: Clip.antiAlias,
          child: isImage
              ? Image.memory(
                  file.bytes,
                  fit: BoxFit.cover,
                  cacheWidth: 224,
                  cacheHeight: 224,
                )
              : _pdfCard(file.displayName ?? 'Documento PDF'),
        ),
        Positioned(
          top: 2,
          right: 2,
          child: Material(
            color: Colors.black54,
            shape: const CircleBorder(),
            child: IconButton(
              constraints: const BoxConstraints.tightFor(width: 30, height: 30),
              padding: EdgeInsets.zero,
              color: Colors.white,
              iconSize: 18,
              onPressed: () => _removeFile(index),
              icon: const Icon(Icons.close),
              tooltip: 'Quitar documento',
            ),
          ),
        ),
      ],
    );
  }

  Widget _existingPreview(String url) {
    final isPdf = url.toLowerCase().contains('.pdf');
    return Container(
      width: 112,
      height: 112,
      decoration: BoxDecoration(
        color: Colors.grey.shade100,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.black12),
      ),
      clipBehavior: Clip.antiAlias,
      child: isPdf
          ? _pdfCard('PDF guardado')
          : Image.network(
              url,
              fit: BoxFit.cover,
              cacheWidth: 224,
              cacheHeight: 224,
              errorBuilder: (_, __, ___) => _pdfCard('Vista no disponible'),
            ),
    );
  }

  Widget _pdfCard(String name) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Icon(Icons.picture_as_pdf, color: Colors.red, size: 38),
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6),
          child: Text(
            name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 11),
          ),
        ),
      ],
    );
  }
}
