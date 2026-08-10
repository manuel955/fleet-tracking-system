// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use

import 'dart:async';
import 'dart:convert';
import 'dart:html' as html;
import 'dart:js' as js;
import 'dart:ui_web' as ui_web;

import 'package:flutter/widgets.dart';

class MapboxWebSurface extends StatefulWidget {
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
  State<MapboxWebSurface> createState() => _MapboxWebSurfaceState();
}

class _MapboxWebSurfaceState extends State<MapboxWebSurface> {
  static final Set<String> _registeredViewTypes = <String>{};
  late final String _viewType;
  StreamSubscription<html.Event>? _eventSubscription;

  @override
  void initState() {
    super.initState();
    _viewType = 'fleet-mapbox-view-${widget.viewId}';
    _registerViewFactory();
    _eventSubscription = html.window.on['fleet-mapbox-event'].listen(_onEvent);
    scheduleMicrotask(_createMap);
  }

  void _registerViewFactory() {
    if (!_registeredViewTypes.add(_viewType)) return;
    ui_web.platformViewRegistry.registerViewFactory(_viewType, (int _) {
      return html.DivElement()
        ..id = widget.viewId
        ..style.width = '100%'
        ..style.height = '100%';
    });
  }

  void _createMap() {
    try {
      js.context.callMethod('fleetMapboxCreate', <Object?>[
        widget.viewId,
        widget.token,
        widget.styleUri,
        widget.initialLat,
        widget.initialLng,
        widget.initialZoom,
        widget.scrollGesturesEnabled,
        widget.zoomGesturesEnabled,
      ]);
      js.context.callMethod('fleetMapboxUpdate', <Object?>[
        widget.viewId,
        widget.markersJson,
      ]);
    } catch (_) {
      widget.onEvent(
        jsonEncode(<String, dynamic>{'id': widget.viewId, 'type': 'error'}),
      );
    }
  }

  void _onEvent(html.Event event) {
    if (event is! html.CustomEvent) return;
    final raw = event.detail?.toString();
    if (raw == null || raw.isEmpty) return;
    try {
      final data = jsonDecode(raw) as Map<String, dynamic>;
      if (data['id']?.toString() == widget.viewId) widget.onEvent(raw);
    } catch (_) {
      // Los eventos malformados no deben interrumpir la interfaz Flutter.
    }
  }

  @override
  void didUpdateWidget(covariant MapboxWebSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.markersJson != widget.markersJson) {
      try {
        js.context.callMethod('fleetMapboxUpdate', <Object?>[
          widget.viewId,
          widget.markersJson,
        ]);
      } catch (_) {}
    }
  }

  @override
  void dispose() {
    _eventSubscription?.cancel();
    try {
      js.context.callMethod('fleetMapboxDestroy', <Object?>[widget.viewId]);
    } catch (_) {}
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => HtmlElementView(viewType: _viewType);
}

void setCamera(
  String viewId,
  double lat,
  double lng,
  double? zoom,
  bool animated,
) {
  try {
    js.context.callMethod('fleetMapboxSetCamera', <Object?>[
      viewId,
      lat,
      lng,
      zoom,
      animated,
    ]);
  } catch (_) {}
}

void resizeMap(String viewId) {
  try {
    js.context.callMethod('fleetMapboxResize', <Object?>[viewId]);
  } catch (_) {}
}
