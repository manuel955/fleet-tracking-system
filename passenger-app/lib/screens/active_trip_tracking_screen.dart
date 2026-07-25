import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/car_icon.dart';
import '../services/directions_service.dart';
import '../services/trip_service.dart';
import '../widgets/labeled_icon_button.dart';
import '../widgets/support_button.dart';
import 'destination_picker_screen.dart';

/// Viaje ya aceptado por un conductor, estilo Uber: mapa a pantalla
/// completa con un panel inferior fijo mostrando el estado y los datos del
/// conductor (nombre, placa, telefono) y su ubicacion en vivo (reusando el
/// mismo nodo drivers/{driverId} que ya lee el dashboard).
class ActiveTripTrackingScreen extends StatefulWidget {
  final String tripId;
  final Map<String, dynamic> trip;
  final VoidCallback onFinished;

  const ActiveTripTrackingScreen({
    super.key,
    required this.tripId,
    required this.trip,
    required this.onFinished,
  });

  @override
  State<ActiveTripTrackingScreen> createState() => _ActiveTripTrackingScreenState();
}

class _ActiveTripTrackingScreenState extends State<ActiveTripTrackingScreen> {
  Timer? _tripTimer;
  Timer? _driverTimer;
  late Map<String, dynamic> _trip;
  LatLng? _driverLatLng;

  // Ruta real conductor -> punto de recogida (o destino, una vez a bordo),
  // recalculada con cada posicion nueva del conductor -- si se desvia de la
  // sugerida, la linea se vuelve a trazar desde donde esta de verdad.
  List<LatLng> _routePoints = [];
  LatLng? _lastRouteOrigin;
  ({double lat, double lng})? _lastRouteTarget;
  int _routeReqToken = 0;
  bool _busy = false;
  BitmapDescriptor? _carIcon;

  @override
  void initState() {
    super.initState();
    _trip = widget.trip;
    _tripTimer = Timer.periodic(const Duration(seconds: 4), (_) => _pollTrip());
    _driverTimer = Timer.periodic(const Duration(seconds: 5), (_) => _pollDriver());
    _pollDriver();
    CarIcon.build().then((icon) {
      if (mounted) setState(() => _carIcon = icon);
    });
  }

  @override
  void dispose() {
    _tripTimer?.cancel();
    _driverTimer?.cancel();
    super.dispose();
  }

  Future<void> _pollTrip() async {
    try {
      final trip = await TripService.getTrip(widget.tripId);
      if (trip == null) return;
      if (mounted) setState(() => _trip = trip);
      if (trip['status'] == 'completed' || trip['status'] == 'cancelled') {
        await TripService.clearActiveTrip();
        widget.onFinished();
      }
      // El objetivo de la ruta puede cambiar (de "ir a recoger" a "ir al
      // destino") sin que la posicion del conductor se haya movido; se
      // fuerza el recalculo para no quedarse con la linea vieja.
      _refreshRoute(force: true);
    } catch (_) {
      // Reintenta en el siguiente tick.
    }
  }

  Future<void> _pollDriver() async {
    final driverId = _trip['driverId'] as String?;
    if (driverId == null) return;
    try {
      final driver = await TripService.getDriverLocation(driverId);
      if (driver == null) return;
      final lat = driver['lat'] as num?;
      final lng = driver['lng'] as num?;
      if (lat != null && lng != null && mounted) {
        setState(() => _driverLatLng = LatLng(lat.toDouble(), lng.toDouble()));
        _refreshRoute();
      }
    } catch (_) {
      // Reintenta en el siguiente tick.
    }
  }

  // Antes de que el pasajero suba, el objetivo es el punto de recogida; ya
  // con el pasajero a bordo ('in_progress'), el objetivo es el destino.
  ({double lat, double lng})? get _routeTarget {
    if (_trip['status'] == 'in_progress') {
      final lat = _trip['destinationLat'];
      final lng = _trip['destinationLng'];
      if (lat == null || lng == null) return null;
      return (lat: (lat as num).toDouble(), lng: (lng as num).toDouble());
    }
    final lat = _trip['pickupLat'];
    final lng = _trip['pickupLng'];
    if (lat == null || lng == null) return null;
    return (lat: (lat as num).toDouble(), lng: (lng as num).toDouble());
  }

  Future<void> _refreshRoute({bool force = false}) async {
    final origin = _driverLatLng;
    final target = _routeTarget;
    if (origin == null || target == null) return;

    final targetChanged = _lastRouteTarget == null ||
        _lastRouteTarget!.lat != target.lat ||
        _lastRouteTarget!.lng != target.lng;

    // El GPS del conductor reenvia la posicion aunque no se haya movido;
    // sin este filtro se llamaria a Routes API sin necesidad en cada poll.
    if (!force &&
        !targetChanged &&
        _lastRouteOrigin != null &&
        Geolocator.distanceBetween(
              _lastRouteOrigin!.latitude,
              _lastRouteOrigin!.longitude,
              origin.latitude,
              origin.longitude,
            ) <
            25) {
      return;
    }

    final token = ++_routeReqToken;
    _lastRouteOrigin = origin;
    _lastRouteTarget = target;
    final destination = LatLng(target.lat, target.lng);

    try {
      final points = await DirectionsService.getRoute(origin, destination);
      if (token != _routeReqToken || !mounted) return;
      setState(() => _routePoints = points);
    } catch (_) {
      if (token != _routeReqToken || !mounted) return;
      setState(() => _routePoints = [origin, destination]);
    }
  }

  Future<void> _callDriver() async {
    final phone = _trip['driverPhone'] as String?;
    if (phone == null || phone.isEmpty) return;
    final ok = await launchUrl(Uri(scheme: 'tel', path: phone));
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No se pudo iniciar la llamada.')),
      );
    }
  }

  // Cancelar solo se ofrece hasta que el conductor marca "pasajero a
  // bordo" (in_progress) -- desde ahi en adelante las reglas de RTDB lo
  // bloquean del lado servidor (ver database/firebase-rules.json).
  bool get _canCancel {
    final status = _trip['status'] as String?;
    return status == 'accepted' || status == 'arrived_at_pickup';
  }

  Future<void> _cancel() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Cancelar viaje'),
        content: const Text('¿Seguro que quieres cancelar este viaje?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('No'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Sí, cancelar', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    setState(() => _busy = true);
    try {
      await TripService.cancelTrip(widget.tripId);
      widget.onFinished();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
        setState(() => _busy = false);
      }
    }
  }

  Future<void> _modifyDestination() async {
    final pickup = LatLng(
      (_trip['pickupLat'] as num).toDouble(),
      (_trip['pickupLng'] as num).toDouble(),
    );
    final result = await Navigator.push<DestinationPickerResult>(
      context,
      MaterialPageRoute(
        builder: (_) => DestinationPickerScreen(
          initialCenter: pickup,
          pickupLabel: _trip['pickupAddress'] as String? ?? 'Mi ubicación actual',
        ),
      ),
    );
    if (result == null) return;

    setState(() => _busy = true);
    try {
      await TripService.updateDestination(
        widget.tripId,
        destinationLat: result.lat,
        destinationLng: result.lng,
        destinationAddress: result.description,
      );
      final trip = await TripService.getTrip(widget.tripId);
      if (mounted && trip != null) setState(() => _trip = trip);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String get _statusLabel {
    switch (_trip['status'] as String?) {
      case 'accepted':
        return 'Tu conductor va en camino';
      case 'arrived_at_pickup':
        return 'Tu conductor llegó';
      case 'in_progress':
        return 'Viaje en curso';
      default:
        return '';
    }
  }

  @override
  Widget build(BuildContext context) {
    final pickup = LatLng(
      (_trip['pickupLat'] as num).toDouble(),
      (_trip['pickupLng'] as num).toDouble(),
    );
    final driverName = _trip['driverName'] as String? ?? '-';
    final initial = driverName.isNotEmpty ? driverName[0].toUpperCase() : '?';

    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: GoogleMap(
              initialCameraPosition: CameraPosition(target: pickup, zoom: 15),
              myLocationButtonEnabled: false,
              zoomControlsEnabled: false,
              padding: const EdgeInsets.only(bottom: 260),
              markers: {
                Marker(
                  markerId: const MarkerId('pickup'),
                  position: pickup,
                  icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
                  infoWindow: const InfoWindow(title: 'Punto de recogida'),
                ),
                if (_driverLatLng != null)
                  Marker(
                    markerId: const MarkerId('driver'),
                    position: _driverLatLng!,
                    icon: _carIcon ?? BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueBlue),
                    anchor: const Offset(0.5, 0.5),
                    infoWindow: const InfoWindow(title: 'Conductor'),
                  ),
                if (_trip['status'] == 'in_progress' &&
                    _trip['destinationLat'] != null &&
                    _trip['destinationLng'] != null)
                  Marker(
                    markerId: const MarkerId('destination'),
                    position: LatLng(
                      (_trip['destinationLat'] as num).toDouble(),
                      (_trip['destinationLng'] as num).toDouble(),
                    ),
                    icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueViolet),
                    infoWindow: const InfoWindow(title: 'Destino'),
                  ),
              },
              polylines: {
                if (_routePoints.length >= 2)
                  Polyline(
                    polylineId: const PolylineId('route'),
                    points: _routePoints,
                    color: const Color(0xFF276EF1),
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
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.only(topLeft: Radius.circular(24), topRight: Radius.circular(24)),
                boxShadow: [BoxShadow(color: Colors.black26, blurRadius: 16, offset: Offset(0, -4))],
              ),
              padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.of(context).padding.bottom + 20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_statusLabel, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  if ((_trip['scheduledPickupLabel'] as String?)?.isNotEmpty == true) ...[
                    const SizedBox(height: 4),
                    Text(
                      'Recogida programada: ${_trip['scheduledPickupLabel']}',
                      style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
                    ),
                  ],
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      CircleAvatar(
                        radius: 26,
                        backgroundColor: Colors.black,
                        child: Text(
                          initial,
                          style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.bold),
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              driverName,
                              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              '${_trip['driverPlate'] ?? '-'} · ${_trip['driverPhone'] ?? '-'}',
                              style: TextStyle(color: Colors.grey.shade600, fontSize: 14),
                            ),
                          ],
                        ),
                      ),
                      LabeledIconButton(
                        icon: Icons.phone,
                        label: 'Llamar',
                        color: const Color(0xFF06C167),
                        onTap: _callDriver,
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: _busy ? null : _modifyDestination,
                          child: const Text('Modificar viaje'),
                        ),
                      ),
                      if (_canCancel) ...[
                        const SizedBox(width: 12),
                        Expanded(
                          child: OutlinedButton(
                            onPressed: _busy ? null : _cancel,
                            style: OutlinedButton.styleFrom(
                              foregroundColor: Colors.red,
                              side: const BorderSide(color: Colors.red),
                            ),
                            child: const Text('Cancelar viaje'),
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
