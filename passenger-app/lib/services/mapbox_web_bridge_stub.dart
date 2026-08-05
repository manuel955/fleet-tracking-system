import 'package:flutter/widgets.dart';

class MapboxWebSurface extends StatelessWidget {
  final String viewId;
  final String token;
  final String styleUri;
  final double initialLat;
  final double initialLng;
  final double initialZoom;
  final String markersJson;
  final ValueChanged<String> onEvent;
  final bool scrollGesturesEnabled;
  final bool zoomGesturesEnabled;

  const MapboxWebSurface({
    super.key,
    required this.viewId,
    required this.token,
    required this.styleUri,
    required this.initialLat,
    required this.initialLng,
    required this.initialZoom,
    required this.markersJson,
    required this.onEvent,
    required this.scrollGesturesEnabled,
    required this.zoomGesturesEnabled,
  });

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

void setCamera(
  String viewId,
  double lat,
  double lng,
  double? zoom,
  bool animated,
) {}

void resizeMap(String viewId) {}
