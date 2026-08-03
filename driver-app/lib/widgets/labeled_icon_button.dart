import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Boton flotante circular-cuadrado con icono + etiqueta chica debajo,
/// para las acciones rapidas que flotan sobre el mapa (Ruta, Soporte).
class LabeledIconButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final Color? color;

  const LabeledIconButton({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    final c = color ?? AppColors.ink;
    return Material(
      color: AppColors.paper,
      borderRadius: BorderRadius.circular(14),
      elevation: 3,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, color: c, size: 22),
              const SizedBox(height: 2),
              Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: c)),
            ],
          ),
        ),
      ),
    );
  }
}
