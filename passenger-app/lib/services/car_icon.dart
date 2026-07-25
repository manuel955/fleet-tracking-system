import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

/// Icono de auto para el marcador del conductor en el mapa del pasajero,
/// dibujado con Canvas en vez de un asset -- mismo espiritu que el
/// buildCarIcon() SVG del dashboard (dashboard/js/app.js), pero
/// google_maps_flutter no acepta SVG como icon, asi que se rasteriza a PNG
/// una sola vez y se cachea.
class CarIcon {
  static BitmapDescriptor? _cached;

  static Future<BitmapDescriptor> build() async {
    final cached = _cached;
    if (cached != null) return cached;

    const double px = 96; // resolucion del PNG; se escala a 36x36 logicos al usarlo.
    const color = Color(0xFF276EF1); // azul "en viaje" del sistema de diseño.

    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder, const Rect.fromLTWH(0, 0, px, px));
    const center = px / 2;

    final borderPaint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = px * 0.055;
    final fillPaint = Paint()..color = Colors.white;
    canvas.drawCircle(const Offset(center, center), center - borderPaint.strokeWidth, fillPaint);
    canvas.drawCircle(const Offset(center, center), center - borderPaint.strokeWidth, borderPaint);

    final bodyPaint = Paint()..color = color;
    final bodyRect = const Rect.fromLTWH(px * 0.20, px * 0.40, px * 0.60, px * 0.28);
    canvas.drawRRect(RRect.fromRectAndRadius(bodyRect, const Radius.circular(px * 0.06)), bodyPaint);

    final cabinPaint = Paint()..color = Colors.white.withValues(alpha: 0.9);
    final cabinRect = const Rect.fromLTWH(px * 0.30, px * 0.30, px * 0.40, px * 0.14);
    canvas.drawRRect(RRect.fromRectAndRadius(cabinRect, const Radius.circular(px * 0.03)), cabinPaint);

    final wheelPaint = Paint()..color = const Color(0xFF1F2937);
    canvas.drawCircle(const Offset(px * 0.32, px * 0.70), px * 0.06, wheelPaint);
    canvas.drawCircle(const Offset(px * 0.68, px * 0.70), px * 0.06, wheelPaint);

    final picture = recorder.endRecording();
    final image = await picture.toImage(px.toInt(), px.toInt());
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    final bytes = byteData!.buffer.asUint8List();

    final descriptor = BitmapDescriptor.bytes(
      Uint8List.fromList(bytes),
      width: 40,
      height: 40,
    );
    _cached = descriptor;
    return descriptor;
  }
}
