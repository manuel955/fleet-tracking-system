import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config.dart';
import '../services/directions_service.dart';
import '../services/map_adapter.dart';
import '../services/notification_service.dart';
import '../services/trip_service.dart';
import '../theme/app_theme.dart';
import '../widgets/labeled_icon_button.dart';
import '../widgets/support_button.dart';
import '../widgets/swipe_to_confirm.dart';

/// Viaje en curso, estilo Uber Conductor: mapa a pantalla completa con una
/// tarjeta inferior fija (datos del pasajero + accion del momento). La
/// asignacion es automatica (sin aceptar/rechazar) y el conductor no puede
/// cancelarlo desde aqui. Un solo gesto de deslizar avanza el ciclo de vida
/// del viaje: He llegado -> Pasajero a bordo -> Finalizar.
class ActiveTripScreen extends StatefulWidget {
  final Map<String, dynamic> trip;
  final String tripId;
  final VoidCallback onFinished;
  // Se ejecuta cuando el backend informa que la pantalla quedo atrasada
  // respecto al viaje real (por ejemplo, cancelacion desde el dashboard o
  // un gesto que ya habia llegado al servidor).
  final Future<void> Function()? onTripStateConflict;
  // Posicion GPS actual del conductor (la misma que ya trackea main.dart en
  // segundo plano), usada solo para exigir cercania real al confirmar
  // "He llegado" -- no se puede confirmar a control remoto.
  final LatLng? currentLatLng;

  const ActiveTripScreen({
    super.key,
    required this.trip,
    required this.tripId,
    required this.onFinished,
    this.onTripStateConflict,
    this.currentLatLng,
  });

  @override
  State<ActiveTripScreen> createState() => _ActiveTripScreenState();
}

class _ActiveTripScreenState extends State<ActiveTripScreen> {
  bool _busy = false;
  // La brújula/recentrado no forma parte de la interfaz operativa.
  final bool _showMapRecenterControl = false;
  MapboxMapController? _mapController;

  // Ruta real dibujada del conductor hasta el punto de recogida o destino
  // (segun la etapa), igual que en el dashboard: se recalcula con cada
  // posicion GPS nueva, asi que si el conductor se desvia de la sugerida la
  // linea se vuelve a trazar desde donde esta de verdad, en vez de quedar
  // pegada a la ruta original.
  List<LatLng> _routePoints = [];
  LatLng? _lastRouteOrigin;
  ({double lat, double lng})? _lastRouteTarget;
  int _routeReqToken = 0;
  DateTime? _lastRouteRequestedAt;
  bool _routeRequestInFlight = false;

  @override
  void initState() {
    super.initState();
    _refreshRoute(force: true);
  }

  @override
  void didUpdateWidget(covariant ActiveTripScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    _refreshRoute();
  }

  Future<void> _refreshRoute({bool force = false}) async {
    final origin = widget.currentLatLng;
    final target = _navTarget;
    if (origin == null || target == null) return;

    final targetChanged = _lastRouteTarget == null ||
        _lastRouteTarget!.lat != target.lat ||
        _lastRouteTarget!.lng != target.lng;

    // El GPS reenvia la posicion cada ~5s aunque el conductor este detenido.
    // La ruta visual se recalcula como maximo cada 30s y cuando avanzo 50m.
    // Se salta el filtro si el objetivo cambio (recogida -> destino).
    final tooSoon = _lastRouteRequestedAt != null &&
        DateTime.now().difference(_lastRouteRequestedAt!) <
            AppConfig.routeRefreshInterval;
    if (!targetChanged && tooSoon) return;
    if (_routeRequestInFlight) return;
    if (!force &&
        !targetChanged &&
        _lastRouteOrigin != null &&
        Geolocator.distanceBetween(
              _lastRouteOrigin!.latitude,
              _lastRouteOrigin!.longitude,
              origin.latitude,
              origin.longitude,
            ) <
            AppConfig.routeRecalculationDistanceMeters) {
      return;
    }

    final token = ++_routeReqToken;
    _routeRequestInFlight = true;
    _lastRouteOrigin = origin;
    _lastRouteTarget = target;
    _lastRouteRequestedAt = DateTime.now();
    final destination = LatLng(target.lat, target.lng);
    // Mantener el mapa sin linea hasta recibir geometria real por carretera.
    if (mounted) setState(() => _routePoints = []);

    try {
      final points = await DirectionsService.getRoute(origin, destination);
      if (token != _routeReqToken || !mounted) return;
      setState(() => _routePoints = points);
    } catch (_) {
      if (token != _routeReqToken || !mounted) return;
      setState(() => _routePoints = []);
    } finally {
      _routeRequestInFlight = false;
    }
  }

  // Un poco mas de una cuadra tipica en Peru (~80-100m), para no exigir
  // precision GPS perfecta pero si descartar confirmar "he llegado"/
  // "finalizar viaje" desde varias calles de distancia.
  static const double _proximityRadiusMeters = 100;

  // Punto contra el que se mide la cercania segun la etapa: el punto de
  // recogida antes de recoger al pasajero, el destino una vez que ya lo
  // lleva a bordo. En "pasajero a bordo" (arrived_at_pickup -> in_progress)
  // no aplica ningun gate de posicion.
  ({double lat, double lng})? get _proximityTarget {
    final trip = widget.trip;
    switch (trip['status'] as String?) {
      case 'accepted':
        final lat = trip['pickupLat'];
        final lng = trip['pickupLng'];
        if (lat == null || lng == null) return null;
        return (lat: (lat as num).toDouble(), lng: (lng as num).toDouble());
      case 'in_progress':
        final lat = trip['destinationLat'];
        final lng = trip['destinationLng'];
        if (lat == null || lng == null) return null;
        return (lat: (lat as num).toDouble(), lng: (lng as num).toDouble());
      default:
        return null;
    }
  }

  double? get _distanceToTargetMeters {
    final here = widget.currentLatLng;
    final target = _proximityTarget;
    if (here == null || target == null) return null;
    return Geolocator.distanceBetween(
        here.latitude, here.longitude, target.lat, target.lng);
  }

  Widget _passengerAvatar(String initial) {
    final photoUrl = widget.trip['passengerPhotoUrl']?.toString().trim();
    final fallback = CircleAvatar(
      radius: 26,
      backgroundColor: AppColors.ink,
      child: Text(
        initial,
        style: const TextStyle(
          color: AppColors.paper,
          fontSize: 20,
          fontWeight: FontWeight.bold,
        ),
      ),
    );
    if (photoUrl == null || photoUrl.isEmpty) return fallback;
    return Container(
      width: 52,
      height: 52,
      decoration: const BoxDecoration(shape: BoxShape.circle),
      clipBehavior: Clip.antiAlias,
      child: Image.network(
        photoUrl,
        fit: BoxFit.cover,
        cacheWidth: 156,
        cacheHeight: 156,
        errorBuilder: (_, __, ___) => fallback,
      ),
    );
  }

  // Sin un fix GPS actual no se permite confirmar. Esto evita que una app
  // recien reabierta pueda finalizar el viaje antes de recuperar la posicion.
  bool get _proximityBlocked {
    if (_proximityTarget == null) return false;
    final distance = _distanceToTargetMeters;
    if (distance == null) return true;
    return distance > _proximityRadiusMeters;
  }

  ({String label, String nextStatus, Color color, IconData icon})? get _action {
    switch (widget.trip['status'] as String?) {
      case 'accepted':
        return (
          label: 'Desliza: he llegado',
          nextStatus: 'arrived_at_pickup',
          color: AppColors.amber,
          icon: Icons.place
        );
      case 'arrived_at_pickup':
        return (
          label: 'Desliza: pasajero a bordo',
          nextStatus: 'in_progress',
          color: AppColors.blue,
          icon: Icons.person
        );
      case 'in_progress':
        return (
          label: 'Desliza: finalizar viaje',
          nextStatus: 'completed',
          color: AppColors.green,
          icon: Icons.flag
        );
      default:
        return null;
    }
  }

  String get _statusLabel {
    switch (widget.trip['status'] as String?) {
      case 'accepted':
        return 'En camino a recoger al pasajero';
      case 'arrived_at_pickup':
        return 'Llegaste al punto de recogida';
      case 'in_progress':
        return 'Viaje en curso';
      default:
        return '';
    }
  }

  bool get _headingToPickup => widget.trip['status'] != 'in_progress';

  // Antes de recoger al pasajero, navega al punto de recogida; ya con el
  // pasajero a bordo, navega al destino (si el pasajero marco uno -- es
  // opcional). No se implementa navegacion propia adentro de la app para
  // no cargarla de peso: se delega a la navegacion externa del telefono.
  ({double lat, double lng})? get _navTarget {
    final trip = widget.trip;
    if (!_headingToPickup) {
      final destLat = trip['destinationLat'];
      final destLng = trip['destinationLng'];
      if (destLat == null || destLng == null) return null;
      return (
        lat: (destLat as num).toDouble(),
        lng: (destLng as num).toDouble()
      );
    }
    return (
      lat: (trip['pickupLat'] as num).toDouble(),
      lng: (trip['pickupLng'] as num).toDouble(),
    );
  }

  Future<void> _recenterToMyLocation() async {
    _refreshRoute(force: true);
    final here = widget.currentLatLng;
    if (here == null || _mapController == null) return;
    _mapController!.animateCamera(CameraUpdate.newLatLngZoom(here, 16));
  }

  Future<void> _openNavigation(double lat, double lng) async {
    final uri = Uri.parse('geo:$lat,$lng?q=$lat,$lng');
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No se pudo abrir la navegacion.')),
      );
    }
  }

  String _distanceHint() {
    final label = widget.trip['status'] == 'in_progress'
        ? 'destino'
        : 'punto de recogida';
    final distance = _distanceToTargetMeters;
    if (distance == null) {
      return 'Esperando una posicion GPS valida para confirmar.';
    }
    final rounded = (distance / 10).round() * 10;
    return 'Acércate al $label (a ${rounded}m) para poder confirmar.';
  }

  Future<void> _callPassenger() async {
    final phone = widget.trip['passengerPhone'] as String?;
    if (phone == null || phone.isEmpty) return;
    final uri = Uri(scheme: 'tel', path: phone);
    final ok = await launchUrl(uri);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No se pudo iniciar la llamada.')),
      );
    }
  }

  Future<void> _advance() async {
    final action = _action;
    if (action == null || _busy) return;
    if (_proximityBlocked) return;
    setState(() => _busy = true);
    try {
      await TripService.advanceTrip(widget.tripId, action.nextStatus);
      if (action.nextStatus == 'completed') {
        widget.onFinished();
      }
    } on TripStateConflictException catch (_) {
      // No dejamos al conductor atrapado en una pantalla antigua. El
      // callback vuelve a leer currentTripId y trips/{tripId}; si el viaje
      // avanzo, la tarjeta cambia de etapa, y si fue cancelado/terminado,
      // la pantalla activa desaparece.
      await widget.onTripStateConflict?.call();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('El viaje cambio. La pantalla fue actualizada.'),
          ),
        );
      }
    } on TripActionRejectedException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(error.message)),
        );
      }
    } catch (e) {
      if (mounted) {
        final message = e.toString().replaceFirst('Exception: ', '');
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(message)),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final trip = widget.trip;
    final navTarget = _navTarget;
    final markerPosition = navTarget != null
        ? LatLng(navTarget.lat, navTarget.lng)
        : LatLng((trip['pickupLat'] as num).toDouble(),
            (trip['pickupLng'] as num).toDouble());
    final action = _action;
    final passengerName = trip['passengerName'] as String? ?? 'Pasajero';
    final initial =
        passengerName.isNotEmpty ? passengerName[0].toUpperCase() : '?';
    final passengerCount = (trip['passengerCount'] as num?)?.toInt();
    final currentPosition = widget.currentLatLng;
    final mapCenter = currentPosition ?? markerPosition;
    final southwest = LatLng(
      currentPosition == null ||
              currentPosition.latitude < markerPosition.latitude
          ? currentPosition?.latitude ?? markerPosition.latitude
          : markerPosition.latitude,
      currentPosition == null ||
              currentPosition.longitude < markerPosition.longitude
          ? currentPosition?.longitude ?? markerPosition.longitude
          : markerPosition.longitude,
    );
    final northeast = LatLng(
      currentPosition == null ||
              currentPosition.latitude > markerPosition.latitude
          ? currentPosition?.latitude ?? markerPosition.latitude
          : markerPosition.latitude,
      currentPosition == null ||
              currentPosition.longitude > markerPosition.longitude
          ? currentPosition?.longitude ?? markerPosition.longitude
          : markerPosition.longitude,
    );

    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: MapboxMapView(
              initialCameraPosition: CameraPosition(
                  target: mapCenter, zoom: currentPosition == null ? 15 : 14),
              onMapCreated: (controller) {
                _mapController = controller;
                if (currentPosition != null) {
                  unawaited(
                    controller.animateCamera(
                      CameraUpdate.newLatLngBounds(
                        LatLngBounds(
                          southwest: southwest,
                          northeast: northeast,
                        ),
                        72,
                      ),
                    ),
                  );
                }
              },
              // El vehiculo propio se pinta como marcador de dominio para no
              // duplicarlo con el punto azul nativo de Mapbox.
              myLocationEnabled: false,
              myLocationButtonEnabled: false,
              zoomControlsEnabled: false,
              padding: const EdgeInsets.only(bottom: 260),
              markers: {
                Marker(
                  markerId: const MarkerId('target'),
                  position: markerPosition,
                  icon: _headingToPickup
                      ? BitmapDescriptor.personMarker
                      : BitmapDescriptor.defaultMarkerWithHue(
                          BitmapDescriptor.hueViolet,
                        ),
                  infoWindow: InfoWindow(
                      title:
                          _headingToPickup ? 'Punto de recogida' : 'Destino'),
                ),
                if (widget.currentLatLng != null)
                  Marker(
                    markerId: const MarkerId('driver'),
                    position: widget.currentLatLng!,
                    icon: BitmapDescriptor.vehicleMarker,
                    anchor: const Offset(0.5, 0.5),
                    infoWindow: const InfoWindow(title: 'Tu vehiculo'),
                  ),
              },
              polylines: {
                if (_routePoints.length >= 2)
                  Polyline(
                    polylineId: const PolylineId('route'),
                    points: _routePoints,
                    color: AppColors.blue,
                    width: 5,
                  ),
              },
            ),
          ),
          const Positioned(
            top: 0,
            right: 16,
            child: SafeArea(
              child: Padding(
                padding: EdgeInsets.only(top: 12),
                child: SupportButton(),
              ),
            ),
          ),
          if (_showMapRecenterControl)
            Positioned(
              top: 0,
              left: 16,
              child: SafeArea(
                child: Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Material(
                    color: AppColors.paper,
                    shape: const CircleBorder(),
                    elevation: 2,
                    child: IconButton(
                      icon: const Icon(Icons.my_location, color: AppColors.ink),
                      tooltip: 'Actualizar posición',
                      onPressed: _recenterToMyLocation,
                    ),
                  ),
                ),
              ),
            ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              decoration: const BoxDecoration(
                color: AppColors.paper,
                borderRadius: BorderRadius.only(
                    topLeft: Radius.circular(24),
                    topRight: Radius.circular(24)),
                boxShadow: [
                  BoxShadow(
                      color: Colors.black26,
                      blurRadius: 16,
                      offset: Offset(0, -4))
                ],
              ),
              padding: EdgeInsets.fromLTRB(
                  20, 20, 20, MediaQuery.of(context).padding.bottom + 20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_statusLabel,
                      style: const TextStyle(
                          fontSize: 18, fontWeight: FontWeight.bold)),
                  if ((trip['scheduledPickupLabel'] as String?)?.isNotEmpty ==
                      true) ...[
                    const SizedBox(height: 4),
                    Text(
                      'Viaje programado: ${NotificationService.scheduledPickupText(trip['scheduledPickupLabel'] as String?)}',
                      style:
                          const TextStyle(fontSize: 13, color: AppColors.muted),
                    ),
                  ],
                  if (passengerCount != null && passengerCount > 0) ...[
                    const SizedBox(height: 4),
                    Text(
                      'Viaje para $passengerCount ${passengerCount == 1 ? 'pasajero' : 'pasajeros'}',
                      style:
                          const TextStyle(fontSize: 13, color: AppColors.muted),
                    ),
                  ],
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      _passengerAvatar(initial),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(passengerName,
                                style: const TextStyle(
                                    fontSize: 16, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 2),
                            Text(
                              trip['passengerPhone'] as String? ?? '-',
                              style: const TextStyle(
                                  color: AppColors.muted, fontSize: 14),
                            ),
                          ],
                        ),
                      ),
                      LabeledIconButton(
                        icon: Icons.phone,
                        label: 'Llamar',
                        color: AppColors.green,
                        onTap: _callPassenger,
                      ),
                      if (navTarget != null) ...[
                        const SizedBox(width: 10),
                        LabeledIconButton(
                          icon: Icons.navigation,
                          label: 'Ruta',
                          color: AppColors.blue,
                          onTap: () =>
                              _openNavigation(navTarget.lat, navTarget.lng),
                        ),
                      ],
                    ],
                  ),
                  if (action != null) ...[
                    if (_proximityBlocked) ...[
                      const SizedBox(height: 12),
                      Text(
                        _distanceHint(),
                        style: const TextStyle(
                            color: AppColors.muted, fontSize: 13),
                      ),
                    ],
                    const SizedBox(height: 20),
                    SwipeToConfirm(
                      label: action.label,
                      color: action.color,
                      icon: action.icon,
                      busy: _busy,
                      enabled: !_proximityBlocked,
                      onConfirmed: _advance,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
