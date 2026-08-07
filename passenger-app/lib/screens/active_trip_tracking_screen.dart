import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/car_icon.dart';
import '../services/directions_service.dart';
import '../services/map_adapter.dart';
import '../services/notification_service.dart';
import '../services/trip_service.dart';
import '../config.dart';
import '../theme/app_theme.dart';
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
  State<ActiveTripTrackingScreen> createState() =>
      _ActiveTripTrackingScreenState();
}

class _ActiveTripTrackingScreenState extends State<ActiveTripTrackingScreen> {
  Timer? _tripTimer;
  Timer? _driverTimer;
  late Map<String, dynamic> _trip;
  String? _lastKnownTripStatus;
  LatLng? _driverLatLng;

  // Ruta real conductor -> punto de recogida (o destino, una vez a bordo),
  // recalculada con cada posicion nueva del conductor -- si se desvia de la
  // sugerida, la linea se vuelve a trazar desde donde esta de verdad.
  List<LatLng> _routePoints = [];
  LatLng? _lastRouteOrigin;
  ({double lat, double lng})? _lastRouteTarget;
  int _routeReqToken = 0;
  DateTime? _lastRouteRequestedAt;
  bool _routeRequestInFlight = false;
  bool _tripPollInFlight = false;
  bool _driverPollInFlight = false;
  bool _busy = false;
  // La brújula/recentrado no forma parte de la interfaz operativa.
  final bool _showMapRecenterControl = true;
  BitmapDescriptor? _carIcon;
  MapboxMapController? _mapController;
  bool _followDriver = false;
  Map<String, dynamic>? _driverProfile;

  dynamic _firstPopulatedValue(String key) {
    for (final source in [_driverProfile, _trip]) {
      final value = source?[key];
      if (value is num) {
        if (value > 0) return value;
        continue;
      }
      final text = value?.toString().trim();
      if (text != null && text.isNotEmpty) return text;
    }
    return null;
  }

  String get _driverName {
    final name =
        _firstPopulatedValue('driverName') ?? _firstPopulatedValue('name');
    final value = name?.toString().trim() ?? '';
    final parts = value.split(RegExp(r'\s+')).where((part) => part.isNotEmpty);
    return parts.isEmpty ? '-' : parts.first;
  }

  String get _driverPlate {
    final plate =
        _firstPopulatedValue('driverPlate') ?? _firstPopulatedValue('plate');
    final value = plate?.toString().trim() ?? '';
    return value.isEmpty ? '-' : value.toUpperCase();
  }

  String get _driverVehicleType {
    final value = _firstPopulatedValue('vehicleType')?.toString().trim();
    return value ?? '';
  }

  String get _driverVehicleSeats {
    final value = _firstPopulatedValue('vehicleSeats');
    if (value is num && value > 0) return '${value.toInt()} asientos';
    final parsed = int.tryParse(value?.toString() ?? '');
    if (parsed != null && parsed > 0) return '$parsed asientos';
    return '';
  }

  String get _driverVehicleLabel {
    final parts = [
      _driverVehicleType,
      _driverVehicleSeats,
    ].where((value) => value.isNotEmpty).toList();
    return parts.isEmpty ? 'Datos no disponibles' : parts.join(' \u00b7 ');
  }

  String get _driverVehicleAssetPath {
    final type = _driverVehicleType.toLowerCase().trim().replaceAll(
      RegExp(r'\s+'),
      ' ',
    );
    if (type == 'bus' || type.contains('ómnibus') || type.contains('omnibus')) {
      return 'assets/vehicles/vehicle-bus-dispo.png';
    }
    if (type == 'mini bus' || type == 'minibus') {
      return 'assets/vehicles/vehicle-minibus.png';
    }
    if (type == 'mini van' || type == 'minivan') {
      return 'assets/vehicles/vehicle-minivan.png';
    }
    if (type == 'van') {
      return 'assets/vehicles/vehicle-van-v2.png';
    }
    // "Pickup" era una categoría antigua. La categoría vigente es SUV;
    // ambos valores deben mostrar la misma imagen para viajes históricos.
    if (type == 'pickup' ||
        type == 'pick-up' ||
        type == 'suv' ||
        type == 'camioneta') {
      return 'assets/vehicles/vehicle-suv.png';
    }
    return 'assets/vehicles/vehicle-car-v2.png';
  }

  Widget _vehicleImage() {
    // Las imágenes parten de un acabado neutro y se modulan con el color
    // declarado en el registro. Así se conserva el volumen real del vehículo
    // sin volver a mostrar el color como texto en la tarjeta.
    return SizedBox(
      width: double.infinity,
      height: 92,
      child: Image.asset(
        _driverVehicleAssetPath,
        cacheWidth: 480,
        cacheHeight: 280,
        fit: BoxFit.contain,
      ),
    );
  }

  String? get _driverPhotoUrl {
    final value =
        (_driverProfile?['profilePhotoUrl'] ?? _trip['driverPhotoUrl'])
            ?.toString()
            .trim();
    return value == null || value.isEmpty ? null : value;
  }

  bool _tripViewChanged(Map<String, dynamic> next) {
    const keys = [
      'status',
      'pickupLat',
      'pickupLng',
      'destinationLat',
      'destinationLng',
      'destinationAddress',
      'passengerCount',
      'scheduledPickupLabel',
      'driverId',
      'driverName',
      'driverPlate',
      'driverPhone',
      'driverPhotoUrl',
    ];
    return keys.any((key) => _trip[key] != next[key]);
  }

  bool _driverViewChanged(Map<String, dynamic> next, LatLng? position) {
    if (_driverProfile == null) return true;
    const keys = [
      'name',
      'driverName',
      'plate',
      'driverPlate',
      'vehicleType',
      'vehicleSeats',
      'vehicleColor',
      'profilePhotoUrl',
    ];
    if (keys.any((key) => _driverProfile![key] != next[key])) return true;
    if (position == null || _driverLatLng == null) {
      return position != _driverLatLng;
    }
    return position.latitude != _driverLatLng!.latitude ||
        position.longitude != _driverLatLng!.longitude;
  }

  @override
  void initState() {
    super.initState();
    _trip = widget.trip;
    _lastKnownTripStatus = _trip['status']?.toString();
    _tripTimer = Timer.periodic(const Duration(seconds: 4), (_) => _pollTrip());
    _driverTimer = Timer.periodic(
      AppConfig.driverLocationPollInterval,
      (_) => _pollDriver(),
    );
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
    if (_tripPollInFlight) return;
    _tripPollInFlight = true;
    try {
      final trip = await TripService.getTrip(widget.tripId);
      if (trip == null) return;
      final nextStatus = trip['status']?.toString();
      if (_lastKnownTripStatus != 'arrived_at_pickup' &&
          nextStatus == 'arrived_at_pickup') {
        unawaited(NotificationService.showDriverArrived(widget.tripId));
      }
      _lastKnownTripStatus = nextStatus;
      if (mounted && _tripViewChanged(trip)) setState(() => _trip = trip);
      if (trip['status'] == 'completed' || trip['status'] == 'cancelled') {
        await TripService.clearActiveTrip();
        widget.onFinished();
      }
      // El objetivo de la ruta puede cambiar (de "ir a recoger" a "ir al
      // destino") sin que la posicion del conductor se haya movido; se
      // fuerza el recalculo para no quedarse con la linea vieja.
      _refreshRoute();
    } catch (_) {
      // Reintenta en el siguiente tick.
    } finally {
      _tripPollInFlight = false;
    }
  }

  Future<void> _pollDriver() async {
    final driverId = _trip['driverId'] as String?;
    if (driverId == null) return;
    if (_driverPollInFlight) return;
    _driverPollInFlight = true;
    try {
      final driver = await TripService.getDriverLocation(driverId);
      if (driver == null) return;
      final lat = driver['lat'] as num?;
      final lng = driver['lng'] as num?;
      if (mounted) {
        final driverPosition = lat != null && lng != null
            ? LatLng(lat.toDouble(), lng.toDouble())
            : null;
        if (_driverViewChanged(driver, driverPosition)) {
          setState(() {
            _driverProfile = driver;
            if (driverPosition != null) _driverLatLng = driverPosition;
          });
        }
        if (lat == null || lng == null) return;
        if (_followDriver && driverPosition != null) {
          await _moveCameraTo(driverPosition);
        }
        _refreshRoute();
      }
    } catch (_) {
      // Reintenta en el siguiente tick.
    } finally {
      _driverPollInFlight = false;
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

    final targetChanged =
        _lastRouteTarget == null ||
        _lastRouteTarget!.lat != target.lat ||
        _lastRouteTarget!.lng != target.lng;

    // El GPS del conductor reenvia la posicion aunque no se haya movido. La
    // ruta visual se recalcula como maximo cada 30s y cuando avanzo 50m.
    final tooSoon =
        _lastRouteRequestedAt != null &&
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

  Future<void> _moveCameraTo(LatLng target) async {
    final controller = _mapController;
    if (controller == null) return;
    await controller.animateCamera(
      CameraUpdate.newCameraPosition(CameraPosition(target: target, zoom: 16)),
    );
  }

  Future<void> _centerMap(LatLng pickup) async {
    if (mounted) setState(() => _followDriver = true);
    final target = _driverLatLng ?? pickup;
    await _moveCameraTo(target);
  }

  void _onCameraMoveStarted() {
    if (_followDriver && mounted) setState(() => _followDriver = false);
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
            child: const Text(
              'Sí, cancelar',
              style: TextStyle(color: Colors.red),
            ),
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
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Error: $e')));
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
          pickupLabel:
              _trip['pickupAddress'] as String? ?? 'Mi ubicación actual',
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
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Error: $e')));
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

  String get _passengerCountLabel {
    final raw = _trip['passengerCount'];
    final count = raw is num ? raw.toInt() : int.tryParse('$raw');
    if (count == null || count < 1) return '';
    return 'Viaje para $count ${count == 1 ? 'pasajero' : 'pasajeros'}';
  }

  Widget _driverAvatar(String initial) {
    final photoUrl = _driverPhotoUrl;
    final fallback = Container(
      color: AppColors.inkSurface,
      alignment: Alignment.center,
      child: Text(
        initial,
        style: const TextStyle(
          color: AppColors.paper,
          fontSize: 30,
          fontWeight: FontWeight.w700,
        ),
      ),
    );

    return SizedBox(
      width: 82,
      height: 82,
      child: ClipOval(
        child: photoUrl == null
            ? fallback
            : Image.network(
                photoUrl,
                fit: BoxFit.cover,
                cacheWidth: 246,
                cacheHeight: 246,
                errorBuilder: (_, _, _) => fallback,
              ),
      ),
    );
  }

  Widget _callButton() {
    return Material(
      color: AppColors.ink,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: _callDriver,
        child: const SizedBox(
          height: 50,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.phone, color: AppColors.lime, size: 24),
              SizedBox(width: 10),
              Text(
                'Llamar al conductor',
                style: TextStyle(
                  color: AppColors.paper,
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final pickup = LatLng(
      (_trip['pickupLat'] as num).toDouble(),
      (_trip['pickupLng'] as num).toDouble(),
    );
    final driverName = _driverName;
    final initial = driverName != '-' ? driverName[0].toUpperCase() : '?';

    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: MapboxMapView(
              onMapCreated: (controller) => _mapController = controller,
              onCameraMoveStarted: _onCameraMoveStarted,
              initialCameraPosition: CameraPosition(target: pickup, zoom: 15),
              myLocationButtonEnabled: false,
              zoomControlsEnabled: false,
              padding: const EdgeInsets.only(bottom: 260),
              markers: {
                Marker(
                  markerId: const MarkerId('pickup'),
                  position: pickup,
                  icon: BitmapDescriptor.personMarker,
                  infoWindow: const InfoWindow(title: 'Punto de recogida'),
                ),
                if (_driverLatLng != null)
                  Marker(
                    markerId: const MarkerId('driver'),
                    position: _driverLatLng!,
                    icon: _carIcon ?? BitmapDescriptor.vehicleMarker,
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
                    icon: BitmapDescriptor.defaultMarkerWithHue(
                      BitmapDescriptor.hueViolet,
                    ),
                    infoWindow: const InfoWindow(title: 'Destino'),
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
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: SafeArea(
              top: false,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  if (_showMapRecenterControl)
                    Padding(
                      padding: const EdgeInsets.only(right: 16, bottom: 10),
                      child: Material(
                        color: _followDriver ? AppColors.blue : AppColors.paper,
                        shape: const CircleBorder(),
                        elevation: 4,
                        child: IconButton(
                          tooltip: _followDriver
                              ? 'Dejar de seguir al conductor'
                              : 'Centrar mapa',
                          onPressed: () {
                            if (_followDriver) {
                              setState(() => _followDriver = false);
                            } else {
                              _centerMap(pickup);
                            }
                          },
                          color: _followDriver
                              ? AppColors.paper
                              : AppColors.blue,
                          icon: Icon(
                            _followDriver ? Icons.gps_fixed : Icons.my_location,
                          ),
                        ),
                      ),
                    ),
                  Container(
                    decoration: const BoxDecoration(
                      color: AppColors.paper,
                      borderRadius: BorderRadius.only(
                        topLeft: Radius.circular(24),
                        topRight: Radius.circular(24),
                      ),
                      border: Border.fromBorderSide(
                        BorderSide(color: Colors.black12),
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black26,
                          blurRadius: 16,
                          offset: Offset(0, -4),
                        ),
                      ],
                    ),
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Center(
                          child: Container(
                            width: 48,
                            height: 4,
                            decoration: BoxDecoration(
                              color: AppColors.muted,
                              borderRadius: BorderRadius.circular(4),
                            ),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          _statusLabel,
                          style: const TextStyle(
                            color: AppColors.ink,
                            fontSize: 17,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        if ((_trip['scheduledPickupLabel'] as String?)
                                ?.isNotEmpty ==
                            true) ...[
                          const SizedBox(height: 2),
                          Text(
                            'Recogida programada: ${_trip['scheduledPickupLabel']}',
                            style: const TextStyle(
                              fontSize: 13,
                              color: AppColors.muted,
                            ),
                          ),
                        ],
                        if (_passengerCountLabel.isNotEmpty) ...[
                          const SizedBox(height: 2),
                          Text(
                            _passengerCountLabel,
                            style: const TextStyle(
                              fontSize: 13,
                              color: AppColors.muted,
                            ),
                          ),
                        ],
                        const SizedBox(height: 10),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            _driverAvatar(initial),
                            const SizedBox(width: 8),
                            Expanded(
                              flex: 3,
                              child: Center(child: _vehicleImage()),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              flex: 2,
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Text(
                                    _driverPlate,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    textAlign: TextAlign.right,
                                    style: const TextStyle(
                                      color: AppColors.ink,
                                      fontSize: 22,
                                      fontWeight: FontWeight.w800,
                                    ),
                                  ),
                                  const SizedBox(height: 3),
                                  SizedBox(
                                    width: double.infinity,
                                    height: 22,
                                    child: FittedBox(
                                      fit: BoxFit.scaleDown,
                                      alignment: Alignment.centerRight,
                                      child: Text(
                                        _driverVehicleLabel,
                                        maxLines: 1,
                                        softWrap: false,
                                        textAlign: TextAlign.right,
                                        style: const TextStyle(
                                          color: AppColors.muted,
                                          fontSize: 14,
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          driverName,
                          style: const TextStyle(
                            color: AppColors.ink,
                            fontSize: 19,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 2),
                        const Text(
                          'Conductor asignado',
                          style: TextStyle(
                            color: AppColors.muted,
                            fontSize: 12,
                          ),
                        ),
                        const SizedBox(height: 10),
                        SizedBox(width: double.infinity, child: _callButton()),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Expanded(
                              child: OutlinedButton(
                                onPressed: _busy ? null : _modifyDestination,
                                style: OutlinedButton.styleFrom(
                                  foregroundColor: AppColors.ink,
                                  side: const BorderSide(color: AppColors.line),
                                  minimumSize: const Size.fromHeight(40),
                                ),
                                child: const Text('Modificar viaje'),
                              ),
                            ),
                            if (_canCancel) ...[
                              const SizedBox(width: 12),
                              Expanded(
                                child: OutlinedButton(
                                  onPressed: _busy ? null : _cancel,
                                  style: OutlinedButton.styleFrom(
                                    foregroundColor: AppColors.red,
                                    side: const BorderSide(
                                      color: AppColors.red,
                                    ),
                                    minimumSize: const Size.fromHeight(40),
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
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
