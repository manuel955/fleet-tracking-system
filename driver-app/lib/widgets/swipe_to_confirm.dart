import 'package:flutter/material.dart';

/// Boton deslizable estilo Uber Conductor ("Desliza para...") para las
/// acciones criticas del viaje (llegue / pasajero a bordo / finalizar).
/// Un boton normal es facil de tocar sin querer con el celular en el
/// portavasos o mientras se maneja; el swipe obliga a un gesto intencional.
class SwipeToConfirm extends StatefulWidget {
  final String label;
  final Color color;
  final IconData icon;
  final VoidCallback onConfirmed;
  final bool busy;
  // Cuando es false, el handle queda gris y no responde al gesto (usado
  // para bloquear "He llegado" hasta que el GPS confirme que el conductor
  // esta cerca de verdad del punto de recogida).
  final bool enabled;

  const SwipeToConfirm({
    super.key,
    required this.label,
    required this.color,
    required this.onConfirmed,
    this.icon = Icons.arrow_forward,
    this.busy = false,
    this.enabled = true,
  });

  @override
  State<SwipeToConfirm> createState() => _SwipeToConfirmState();
}

class _SwipeToConfirmState extends State<SwipeToConfirm> {
  static const double _handleSize = 52;

  double _dragX = 0;
  bool _dragging = false;

  @override
  void didUpdateWidget(covariant SwipeToConfirm oldWidget) {
    super.didUpdateWidget(oldWidget);
    // La acción terminó (avanzó de estado o falló): suelta el handle de
    // vuelta al inicio para el próximo intento.
    if (!widget.busy && oldWidget.busy) {
      setState(() => _dragX = 0);
    }
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final maxDrag = (constraints.maxWidth - _handleSize).clamp(0, double.infinity);
        final progress = maxDrag == 0 ? 0.0 : (_dragX / maxDrag).clamp(0.0, 1.0);

        final locked = widget.busy || !widget.enabled;

        return Container(
          height: _handleSize,
          decoration: BoxDecoration(
            color: widget.enabled ? widget.color : Colors.grey.shade400,
            borderRadius: BorderRadius.circular(_handleSize / 2),
          ),
          child: Stack(
            alignment: Alignment.centerLeft,
            children: [
              Center(
                child: Opacity(
                  opacity: 1 - progress,
                  child: Text(
                    widget.label,
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 15),
                  ),
                ),
              ),
              AnimatedPositioned(
                duration: _dragging ? Duration.zero : const Duration(milliseconds: 200),
                curve: Curves.easeOut,
                left: _dragX,
                top: 0,
                bottom: 0,
                child: GestureDetector(
                  onHorizontalDragStart: locked ? null : (_) => setState(() => _dragging = true),
                  onHorizontalDragUpdate: locked
                      ? null
                      : (details) => setState(() {
                            _dragX = (_dragX + details.delta.dx).clamp(0, maxDrag.toDouble());
                          }),
                  onHorizontalDragEnd: locked
                      ? null
                      : (_) {
                          setState(() => _dragging = false);
                          if (_dragX >= maxDrag * 0.75) {
                            setState(() => _dragX = maxDrag.toDouble());
                            widget.onConfirmed();
                          } else {
                            setState(() => _dragX = 0);
                          }
                        },
                  child: Container(
                    width: _handleSize,
                    height: _handleSize,
                    padding: const EdgeInsets.all(3),
                    child: Container(
                      decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
                      child: widget.busy
                          ? const Padding(
                              padding: EdgeInsets.all(14),
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Icon(widget.icon, color: Colors.black87),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
