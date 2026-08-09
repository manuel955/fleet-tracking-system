import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mb;

import '../config.dart';

class LatLng {
  final double latitude;
  final double longitude;

  const LatLng(this.latitude, this.longitude);

  @override
  bool operator ==(Object other) =>
      other is LatLng &&
      other.latitude == latitude &&
      other.longitude == longitude;

  @override
  int get hashCode => Object.hash(latitude, longitude);
}

class LatLngBounds {
  final LatLng southwest;
  final LatLng northeast;

  const LatLngBounds({required this.southwest, required this.northeast});
}

class CameraPosition {
  final LatLng target;
  final double zoom;

  const CameraPosition({required this.target, required this.zoom});
}

class CameraUpdate {
  final LatLng? target;
  final double? zoom;
  final CameraPosition? position;
  final LatLngBounds? bounds;
  final bool animated;

  const CameraUpdate._({
    this.target,
    this.zoom,
    this.position,
    this.bounds,
    required this.animated,
  });

  factory CameraUpdate.newLatLng(LatLng target) =>
      CameraUpdate._(target: target, animated: true);

  factory CameraUpdate.newLatLngZoom(LatLng target, double zoom) =>
      CameraUpdate._(target: target, zoom: zoom, animated: true);

  factory CameraUpdate.newCameraPosition(CameraPosition position) =>
      CameraUpdate._(position: position, animated: true);

  factory CameraUpdate.newLatLngBounds(LatLngBounds bounds, double padding) =>
      CameraUpdate._(bounds: bounds, zoom: padding, animated: true);
}

class MapboxMapController {
  mb.MapboxMap? _map;

  void _bind(mb.MapboxMap map) => _map = map;

  Future<void> animateCamera(CameraUpdate update) =>
      _apply(update, animated: true);

  Future<void> moveCamera(CameraUpdate update) =>
      _apply(update, animated: false);

  Future<void> _apply(CameraUpdate update, {required bool animated}) async {
    final map = _map;
    if (map == null) return;
    try {
      mb.CameraOptions options;
      if (update.bounds != null) {
        final bounds = update.bounds!;
        final padding = (update.zoom ?? 48).clamp(0, 240).toDouble();
        options = await map.cameraForCoordinatesPadding(
          [_point(bounds.southwest), _point(bounds.northeast)],
          mb.CameraOptions(),
          mb.MbxEdgeInsets(
            top: padding,
            left: padding,
            bottom: padding,
            right: padding,
          ),
          17,
          null,
        );
      } else {
        final target = update.position?.target ?? update.target;
        options = mb.CameraOptions(
          center: target == null ? null : _point(target),
          zoom: update.position?.zoom ?? update.zoom,
        );
      }
      if (animated) {
        await map.easeTo(options, mb.MapAnimationOptions(duration: 450));
      } else {
        await map.setCamera(options);
      }
    } catch (_) {}
  }

  Future<void> resize() async {}

  mb.Point _point(LatLng value) =>
      mb.Point(coordinates: mb.Position(value.longitude, value.latitude));
}

class MarkerId {
  final String value;
  const MarkerId(this.value);
  @override
  bool operator ==(Object other) => other is MarkerId && other.value == value;
  @override
  int get hashCode => value.hashCode;
}

class PolylineId {
  final String value;
  const PolylineId(this.value);
  @override
  bool operator ==(Object other) => other is PolylineId && other.value == value;
  @override
  int get hashCode => value.hashCode;
}

class InfoWindow {
  final String? title;
  const InfoWindow({this.title});
}

class BitmapDescriptor {
  final int color;
  final String? glyph;
  const BitmapDescriptor._(this.color, [this.glyph]);
  static const double hueAzure = 210;
  static const double hueBlue = 240;
  static const double hueViolet = 270;

  static const BitmapDescriptor personMarker = BitmapDescriptor._(
    0xFF1976D2,
    'person',
  );
  static const BitmapDescriptor vehicleMarker = BitmapDescriptor._(
    0xFF1976D2,
    'vehicle',
  );

  static BitmapDescriptor defaultMarkerWithHue(double hue) {
    if (hue >= 250) return const BitmapDescriptor._(0xFF7E57C2);
    return const BitmapDescriptor._(0xFF1976D2);
  }
}

class _MapMarkerImageCache {
  static final Map<String, Future<Uint8List>> _cache = {};

  static Future<Uint8List> bytesFor(String kind) =>
      _cache.putIfAbsent(kind, () => _build(kind));

  static Future<Uint8List> _build(String kind) async {
    const size = 72.0;
    final recorder = ui.PictureRecorder();
    final canvas =
        ui.Canvas(recorder, const ui.Rect.fromLTWH(0, 0, size, size));
    final blue = ui.Paint()..color = const Color(0xFF1976D2);
    final white = ui.Paint()..color = const Color(0xFFFFFFFF);
    final dark = ui.Paint()..color = const Color(0xFF17202A);

    canvas.drawCircle(const ui.Offset(size / 2, size / 2), 31, white);
    if (kind == 'person') {
      canvas.drawCircle(const ui.Offset(36, 23), 10, dark);
      canvas.drawRRect(
        ui.RRect.fromRectAndRadius(
          const ui.Rect.fromLTWH(18, 35, 36, 22),
          const ui.Radius.circular(11),
        ),
        blue,
      );
    } else {
      canvas.drawRRect(
        ui.RRect.fromRectAndRadius(
          const ui.Rect.fromLTWH(8, 30, 56, 24),
          const ui.Radius.circular(8),
        ),
        blue,
      );
      final roof = ui.Path()
        ..moveTo(17, 30)
        ..lineTo(25, 18)
        ..lineTo(48, 18)
        ..lineTo(57, 30)
        ..close();
      canvas.drawPath(roof, blue);
      canvas.drawCircle(const ui.Offset(21, 55), 7, dark);
      canvas.drawCircle(const ui.Offset(51, 55), 7, dark);
      canvas.drawCircle(const ui.Offset(21, 55), 3, white);
      canvas.drawCircle(const ui.Offset(51, 55), 3, white);
    }

    final image =
        await recorder.endRecording().toImage(size.toInt(), size.toInt());
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    return data!.buffer.asUint8List();
  }
}

class Marker {
  final MarkerId markerId;
  final LatLng position;
  final BitmapDescriptor? icon;
  final InfoWindow infoWindow;
  final bool draggable;
  final ValueChanged<LatLng>? onDragEnd;
  final VoidCallback? onTap;
  final double opacity;
  final Offset? anchor;

  const Marker({
    required this.markerId,
    required this.position,
    this.icon,
    this.infoWindow = const InfoWindow(),
    this.draggable = false,
    this.onDragEnd,
    this.onTap,
    this.opacity = 1,
    this.anchor,
  });
}

class Polyline {
  final PolylineId polylineId;
  final List<LatLng> points;
  final Color color;
  final int width;

  const Polyline({
    required this.polylineId,
    required this.points,
    this.color = Colors.blue,
    this.width = 4,
  });
}

class MapboxMapView extends StatefulWidget {
  final CameraPosition initialCameraPosition;
  final void Function(MapboxMapController controller)? onMapCreated;
  final Set<Marker> markers;
  final Set<Polyline> polylines;
  final ValueChanged<LatLng>? onTap;
  final ValueChanged<CameraPosition>? onCameraMove;
  final VoidCallback? onCameraIdle;
  final VoidCallback? onCameraMoveStarted;
  final EdgeInsets? padding;
  final bool myLocationEnabled;
  final bool myLocationButtonEnabled;
  final bool zoomControlsEnabled;

  const MapboxMapView({
    super.key,
    required this.initialCameraPosition,
    this.onMapCreated,
    this.markers = const <Marker>{},
    this.polylines = const <Polyline>{},
    this.onTap,
    this.onCameraMove,
    this.onCameraIdle,
    this.onCameraMoveStarted,
    this.padding,
    this.myLocationEnabled = false,
    this.myLocationButtonEnabled = false,
    this.zoomControlsEnabled = false,
  });

  @override
  State<MapboxMapView> createState() => _MapboxMapViewState();
}

class _MapboxMapViewState extends State<MapboxMapView> {
  final MapboxMapController _controller = MapboxMapController();
  mb.MapboxMap? _map;
  mb.CircleAnnotationManager? _circleManager;
  mb.PointAnnotationManager? _pointManager;
  mb.PolylineAnnotationManager? _polylineManager;
  final Map<String, mb.CircleAnnotation> _mapMarkers = {};
  final Map<String, mb.PointAnnotation> _pointMarkers = {};
  mb.PolylineAnnotation? _routeAnnotation;
  mb.Cancelable? _tapSubscription;
  mb.Cancelable? _pointTapSubscription;
  mb.Cancelable? _dragSubscription;
  final Map<String, LatLng> _renderedMarkerPositions = {};
  final Map<String, int> _markerAnimationTokens = {};
  bool _syncing = false;
  bool _syncPending = false;
  String? _error;
  Timer? _retryTimer;
  int _mapAttempt = 0;

  @override
  void didUpdateWidget(covariant MapboxMapView oldWidget) {
    super.didUpdateWidget(oldWidget);
    _queueAnnotationSync();
  }

  @override
  void dispose() {
    _retryTimer?.cancel();
    _tapSubscription?.cancel();
    _pointTapSubscription?.cancel();
    _dragSubscription?.cancel();
    _markerAnimationTokens.clear();
    _renderedMarkerPositions.clear();
    super.dispose();
  }

  void _onMapCreated(mb.MapboxMap map) {
    _map = map;
    _controller._bind(map);
    widget.onMapCreated?.call(_controller);
    _error = null;
    _retryTimer?.cancel();
    _retryTimer = null;
    unawaited(_hideMapControls(map));
    _queueAnnotationSync();
  }

  Future<void> _hideMapControls(mb.MapboxMap map) async {
    try {
      await map.scaleBar.updateSettings(mb.ScaleBarSettings(enabled: false));
      await map.compass.updateSettings(mb.CompassSettings(enabled: false));
    } catch (_) {
      // Los controles ornamentales no deben bloquear el mapa si el SDK aun carga.
    }
  }

  void _onMapLoadError(mb.MapLoadingErrorEventData _) {
    if (mounted) {
      setState(() => _error = 'No se pudo cargar el mapa. Revisa tu conexion.');
      _scheduleRetry();
    }
  }

  void _scheduleRetry() {
    if (_retryTimer != null || _mapAttempt >= 3) return;
    _retryTimer = Timer(const Duration(seconds: 2), () {
      _retryTimer = null;
      if (mounted) {
        setState(() {
          _error = null;
          _mapAttempt++;
        });
      }
    });
  }

  void _retryMap() {
    _retryTimer?.cancel();
    _retryTimer = null;
    setState(() {
      _error = null;
      _mapAttempt++;
    });
  }

  void _onCameraChange(mb.CameraChangedEventData event) {
    final position = event.cameraState.center.coordinates;
    widget.onCameraMove?.call(
      CameraPosition(
        target: LatLng(position.lat.toDouble(), position.lng.toDouble()),
        zoom: event.cameraState.zoom,
      ),
    );
  }

  void _onMapTap(mb.MapContentGestureContext context) {
    final position = context.point.coordinates;
    widget.onTap
        ?.call(LatLng(position.lat.toDouble(), position.lng.toDouble()));
  }

  void _queueAnnotationSync() {
    if (_map == null) return;
    if (_syncing) {
      _syncPending = true;
      return;
    }
    _syncing = true;
    _syncAnnotations().whenComplete(() {
      _syncing = false;
      if (_syncPending) {
        _syncPending = false;
        _queueAnnotationSync();
      }
    });
  }

  Future<void> _syncAnnotations() async {
    final map = _map;
    if (map == null || !mounted) return;
    try {
      _circleManager ??= await map.annotations.createCircleAnnotationManager(
        id: 'domain-markers',
      );
      try {
        _pointManager ??= await map.annotations.createPointAnnotationManager(
          id: 'domain-glyph-markers',
        );
      } catch (error) {
        debugPrint('[DriverMap] glyph manager unavailable: $error');
      }
      _polylineManager ??=
          await map.annotations.createPolylineAnnotationManager(
        id: 'domain-routes',
      );
      final circles = _circleManager!;
      final incoming = <String, Marker>{
        for (final marker in widget.markers) marker.markerId.value: marker,
      };
      for (final id in _mapMarkers.keys.toList()) {
        if (!incoming.containsKey(id)) {
          _markerAnimationTokens[id] = (_markerAnimationTokens[id] ?? 0) + 1;
          _renderedMarkerPositions.remove(id);
          await circles.delete(_mapMarkers.remove(id)!);
        }
      }
      for (final id in _pointMarkers.keys.toList()) {
        if (!incoming.containsKey(id)) {
          final point = _pointMarkers.remove(id);
          if (point != null) await _pointManager?.delete(point);
        }
      }
      for (final entry in incoming.entries) {
        final marker = entry.value;
        final glyph = marker.icon?.glyph;
        if (glyph != null && _pointManager != null) {
          try {
            final iconBytes = await _MapMarkerImageCache.bytesFor(glyph);
            final iconSize = glyph == 'vehicle' ? 0.9 : 0.78;
            if (_mapMarkers.containsKey(entry.key)) {
              await circles.delete(_mapMarkers.remove(entry.key)!);
            }
            final point = _pointMarkers[entry.key];
            if (point == null) {
              _pointMarkers[entry.key] = await _pointManager!.create(
                mb.PointAnnotationOptions(
                  geometry: _point(marker.position),
                  image: iconBytes,
                  iconSize: iconSize,
                  iconOpacity: marker.opacity,
                  isDraggable: marker.draggable,
                  customData: <String, Object>{'id': entry.key},
                ),
              );
            } else {
              point
                ..geometry = _point(marker.position)
                ..image = iconBytes
                ..iconSize = iconSize
                ..iconOpacity = marker.opacity
                ..isDraggable = marker.draggable;
              await _pointManager!.update(point);
            }
            continue;
          } catch (error) {
            debugPrint('[DriverMap] glyph marker failed: $error');
            final point = _pointMarkers.remove(entry.key);
            if (point != null) await _pointManager?.delete(point);
          }
        }
        if (glyph != null) {
          if (_mapMarkers.containsKey(entry.key)) {
            await circles.delete(_mapMarkers.remove(entry.key)!);
          }
        }
        if (_pointMarkers.containsKey(entry.key)) {
          final point = _pointMarkers.remove(entry.key);
          if (point != null) await _pointManager?.delete(point);
        }
        final annotation = _mapMarkers[entry.key];
        if (annotation == null) {
          _mapMarkers[entry.key] = await circles.create(
            mb.CircleAnnotationOptions(
              geometry: _point(marker.position),
              circleColor: marker.icon?.color ?? 0xFF276EF1,
              circleRadius: 8,
              circleOpacity: marker.opacity,
              circleStrokeColor: 0xFFFFFFFF,
              circleStrokeWidth: 2,
              isDraggable: marker.draggable,
              customData: <String, Object>{'id': entry.key},
            ),
          );
          _renderedMarkerPositions[entry.key] = marker.position;
        } else {
          annotation.circleColor = marker.icon?.color ?? 0xFF276EF1;
          annotation.circleOpacity = marker.opacity;
          annotation.isDraggable = marker.draggable;
          annotation.geometry = _point(marker.position);
          _renderedMarkerPositions[entry.key] = marker.position;
          await circles.update(annotation);
        }
      }
      final route = widget.polylines.isEmpty ? null : widget.polylines.first;
      if (route == null || route.points.length < 2) {
        final oldRoute = _routeAnnotation;
        if (oldRoute != null) {
          await _polylineManager!.delete(oldRoute);
          _routeAnnotation = null;
        }
      } else {
        final geometry = mb.LineString(
          coordinates: route.points.map(_position).toList(),
        );
        if (_routeAnnotation == null) {
          _routeAnnotation = await _polylineManager!.create(
            mb.PolylineAnnotationOptions(
              geometry: geometry,
              lineColor: route.color.toARGB32(),
              lineWidth: route.width.toDouble(),
              lineOpacity: 0.95,
            ),
          );
        } else {
          _routeAnnotation!
            ..geometry = geometry
            ..lineColor = route.color.toARGB32()
            ..lineWidth = route.width.toDouble();
          await _polylineManager!.update(_routeAnnotation!);
        }
      }
      _tapSubscription ??= circles.tapEvents(onTap: (annotation) {
        final id = annotation.customData?['id']?.toString();
        if (id == null) return;
        for (final marker in widget.markers) {
          if (marker.markerId.value == id) marker.onTap?.call();
        }
      });
      if (_pointManager != null) {
        _pointTapSubscription ??= _pointManager!.tapEvents(onTap: (annotation) {
          final id = annotation.customData?['id']?.toString();
          if (id == null) return;
          for (final marker in widget.markers) {
            if (marker.markerId.value == id) marker.onTap?.call();
          }
        });
      }
      _dragSubscription ??= circles.dragEvents(onEnd: (annotation) {
        final id = annotation.customData?['id']?.toString();
        if (id == null) return;
        final position = annotation.geometry.coordinates;
        for (final marker in widget.markers) {
          if (marker.markerId.value == id) {
            marker.onDragEnd?.call(
              LatLng(position.lat.toDouble(), position.lng.toDouble()),
            );
          }
        }
      });
    } catch (error, stackTrace) {
      debugPrint('[DriverMap] annotation sync failed: $error');
      debugPrintStack(stackTrace: stackTrace);
    }
  }

  mb.Point _point(LatLng value) =>
      mb.Point(coordinates: mb.Position(value.longitude, value.latitude));

  mb.Position _position(LatLng value) =>
      mb.Position(value.longitude, value.latitude);

  @override
  Widget build(BuildContext context) {
    if (AppConfig.mapboxAccessToken.isEmpty) {
      return const ColoredBox(
        color: Color(0xFFF1F3F2),
        child: Center(
          child: Text(
            'Mapa no configurado. Contacta al administrador.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.black54),
          ),
        ),
      );
    }
    if (_error != null) {
      return ColoredBox(
        color: Colors.grey.shade100,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_error!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.black54)),
              const SizedBox(height: 12),
              OutlinedButton(
                  onPressed: _retryMap, child: const Text('Reintentar mapa')),
            ],
          ),
        ),
      );
    }
    return mb.MapWidget(
      key: ValueKey('driver-map-$_mapAttempt'),
      // Huawei puede dejar la superficie Virtual Display en blanco o
      // parcialmente renderizada. Hybrid Composition mantiene el mapa nativo
      // correctamente compuesto con la interfaz Flutter.
      // ignore: experimental_member_use
      androidHostingMode: mb.AndroidPlatformViewHostingMode.HC,
      styleUri: AppConfig.mapboxStyleUri,
      // ignore: deprecated_member_use
      cameraOptions: mb.CameraOptions(
        center: _point(widget.initialCameraPosition.target),
        zoom: widget.initialCameraPosition.zoom,
      ),
      onMapCreated: _onMapCreated,
      onMapLoadedListener: (_) {
        final map = _map;
        if (map != null) unawaited(_hideMapControls(map));
      },
      onMapLoadErrorListener: _onMapLoadError,
      onCameraChangeListener: _onCameraChange,
      onMapIdleListener: (_) => widget.onCameraIdle?.call(),
      // ignore: deprecated_member_use
      onTapListener: widget.onTap == null ? null : _onMapTap,
      onScrollListener: (_) => widget.onCameraMoveStarted?.call(),
      onZoomListener: (_) => widget.onCameraMoveStarted?.call(),
    );
  }
}
