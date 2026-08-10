import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/support_config_service.dart';
import '../theme/app_theme.dart';
import 'labeled_icon_button.dart';

/// Boton de soporte, pensado para estar siempre visible (antes, durante y
/// despues del viaje): al tocarlo deja elegir entre llamar o escribir por
/// WhatsApp. El numero se trae de config/supportPhone (editable desde el
/// dashboard, ver SupportConfigService) en el momento de abrir la hoja, asi
/// un cambio hecho en el dashboard se ve sin necesidad de reabrir la app.
class SupportButton extends StatelessWidget {
  const SupportButton({super.key});

  Future<void> _call(BuildContext context, String phone) async {
    final ok = await launchUrl(Uri(scheme: 'tel', path: phone));
    if (!ok && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No se pudo iniciar la llamada.')),
      );
    }
  }

  Future<void> _whatsapp(BuildContext context, String phone) async {
    final digits = phone.replaceAll('+', '');
    final ok = await launchUrl(
      Uri.parse('https://wa.me/$digits'),
      mode: LaunchMode.externalApplication,
    );
    if (!ok && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No se pudo abrir WhatsApp.')),
      );
    }
  }

  Future<void> _openOptions(BuildContext context) async {
    final phone = await SupportConfigService.fetchSupportPhone();
    if (!context.mounted) return;
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.only(
            topLeft: Radius.circular(20), topRight: Radius.circular(20)),
      ),
      builder: (sheetContext) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('Contactar a soporte',
                    style:
                        TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              ),
              ListTile(
                leading: const Icon(Icons.call, color: AppColors.ink),
                title: const Text('Llamar'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  _call(context, phone);
                },
              ),
              ListTile(
                leading: const Icon(Icons.chat, color: AppColors.ink),
                title: const Text('Escribir por WhatsApp'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  _whatsapp(context, phone);
                },
              ),
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return LabeledIconButton(
      icon: Icons.support_agent,
      label: 'Soporte',
      onTap: () => _openOptions(context),
    );
  }
}
