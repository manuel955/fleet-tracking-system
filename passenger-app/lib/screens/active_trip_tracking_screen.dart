import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/car_icon.dart';
import '../services/directions_service.dart';
import '../services/trip_service.dart';
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
  GoogleMapController? _mapController;
  bool _followDriver = false;
  bool _ignoreNextCameraMove = false;
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

  String get _driverVehicleColor {
    final value = _firstPopulatedValue('vehicleColor')?.toString().trim();
    return value ?? '';
  }

  String get _driverVehicleLabel {
    final parts = [
      _driverVehicleType,
      _driverVehicleSeats,
    ].where((value) => value.isNotEmpty).toList();
    return parts.isEmpty ? 'Datos no disponibles' : parts.join(' \u00b7 ');
  }

  Color get _driverVehicleIconColor {
    final color = _driverVehicleColor.toLowerCase();
    if (color.contains('negro') || color.contains('black')) {
      return Colors.black;
    }
    if (color.contains('blanco') || color.contains('white')) {
      return Colors.grey.shade300;
    }
    if (color.contains('rojo') || color.contains('red')) {
      return Colors.red.shade700;
    }
    if (color.contains('azul') || color.contains('blue')) {
      return Colors.blue.shade700;
    }
    if (color.contains('verde') || color.contains('green')) {
      return Colors.green.shade700;
    }
    if (color.contains('amarillo') || color.contains('yellow')) {
      return Colors.amber.shade700;
    }
    if (color.contains('beige') ||
        color.contains('beis') ||
        color.contains('arena') ||
        color.contains('tan')) {
      return const Color(0xFFC7AD82);
    }
    if (color.contains('naranja') || color.contains('orange')) {
      return Colors.orange.shade800;
    }
    if (color.contains('marron') ||
        color.contains('marrón') ||
        color.contains('cafe') ||
        color.contains('café') ||
        color.contains('brown')) {
      return Colors.brown.shade600;
    }
    if (color.contains('morado') ||
        color.contains('purpura') ||
        color.contains('púrpura') ||
        color.contains('purple')) {
      return Colors.deepPurple.shade600;
    }
    if (color.contains('rosa') ||
        color.contains('rosado') ||
        color.contains('pink')) {
      return Colors.pink.shade400;
    }
    if (color.contains('celeste') ||
        color.contains('turquesa') ||
        color.contains('cyan')) {
      return Colors.cyan.shade600;
    }
    if (color.contains('gris') ||
        color.contains('gray') ||
        color.contains('grey') ||
        color.contains('plata') ||
        color.contains('silver')) {
      return Colors.grey.shade600;
    }
    return Colors.grey.shade500;
  }

  String get _driverVehicleAssetPath {
    final type = _driverVehicleType.toLowerCase().trim().replaceAll(
      RegExp(r'\s+'),
      ' ',
    );
    if (type == 'bus' || type.contains('ómnibus') || type.contains('omnibus')) {
      return 'assets/vehicles/vehicle-bus.png';
    }
    if (type == 'van' || type == 'mini van' || type == 'minivan') {
      return 'assets/vehicles/vehicle-van.png';
    }
    if (type == 'camioneta' || type == 'pickup' || type == 'pick-up') {
      return 'assets/vehicles/vehicle-pickup.png';
    }
    return 'assets/vehicles/vehicle-car.png';
  }

  Widget _vehicleImage() {
    // Las imágenes parten de un acabado neutro y se modulan con el color
    // declarado en el registro. Así se conserva el volumen real del vehículo
    // sin volver a mostrar el color como texto en la tarjeta.
    final tint = Color.lerp(Colors.white, _driverVehicleIconColor, 0.78)!;
    return ColorFiltered(
      colorFilter: ColorFilter.mode(tint, BlendMode.modulate),
      child: Image.asset(
        _driverVehicleAssetPath,
        cacheWidth: 320,
        cacheHeight: 180,
        width: 100,
        height: 70,
        fit: BoxFit.contain,
      ),
    );
  }

  String? get _driverPhotoUrl {
    final value = _driverProfile?['profilePhotoUrl']?.toString().trim();
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
      'scheduledPickupLabel',
      'driverId',
      'driverName',
      'driverPlate',
      'driverPhone',
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
    _tripTimer = Timer.periodic(const Duration(seconds: 4), (_) => _pollTrip());
    _driverTimer = Timer.periodic(
      const Duration(seconds: 5),
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
    try {
      final trip = await TripService.getTrip(widget.tripId);
      if (trip == null) return;
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

  Future<void> _moveCameraTo(LatLng target) async {
    final controller = _mapController;
    if (controller == null) return;
    _ignoreNextCameraMove = true;
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
    if (_ignoreNextCameraMove) {
      _ignoreNextCameraMove = false;
      return;
    }
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

  Widget _driverAvatar(String initial) {
    final photoUrl = _driverPhotoUrl;
    final fallback = Container(
      color: const Color(0xFF303030),
      alignment: Alignment.center,
      child: Text(
        initial,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 24,
          fontWeight: FontWeight.w700,
        ),
      ),
    );

    return Container(
      width: 64,
      height: 64,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: const Color(0xFF555555), width: 2),
      ),
      child: ClipOval(
        child: photoUrl == null
            ? fallback
            : Image.network(
                photoUrl,
                fit: BoxFit.cover,
                cacheWidth: 192,
                cacheHeight: 192,
                errorBuilder: (_, _, _) => fallback,
              ),
      ),
    );
  }

  Widget _callButton() {
    return Material(
      color: const Color(0xFF2A2A2A),
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: _callDriver,
        child: const SizedBox(
          height: 50,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.phone, color: Color(0xFF63D391), size: 24),
              SizedBox(width: 10),
              Text(
                'Llamar al conductor',
                style: TextStyle(
                  color: Colors.white,
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
            child: GoogleMap(
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
                  icon: BitmapDescriptor.defaultMarkerWithHue(
                    BitmapDescriptor.hueAzure,
                  ),
                  infoWindow: const InfoWindow(title: 'Punto de recogida'),
                ),
                if (_driverLatLng != null)
                  Marker(
                    markerId: const MarkerId('driver'),
                    position: _driverLatLng!,
                    icon:
                        _carIcon ??
                        BitmapDescriptor.defaultMarkerWithHue(
                          BitmapDescriptor.hueBlue,
                        ),
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
            top: 145,
            right: 16,
            child: SafeArea(
              child: Material(
                color: _followDriver ? const Color(0xFF276EF1) : Colors.white,
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
                  color: _followDriver ? Colors.white : const Color(0xFF276EF1),
                  icon: Icon(
                    _followDriver ? Icons.gps_fixed : Icons.my_location,
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
                color: Colors.white,
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
              padding: EdgeInsets.fromLTRB(
                16,
                8,
                16,
                MediaQuery.of(context).padding.bottom + 10,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Container(
                      width: 48,
                      height: 4,
                      decoration: BoxDecoration(
                        color: const Color(0xFF9E9E9E),
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _statusLabel,
                    style: const TextStyle(
                      color: Colors.black,
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if ((_trip['scheduledPickupLabel'] as String?)?.isNotEmpty ==
                      true) ...[
                    const SizedBox(height: 2),
                    Text(
                      'Recogida programada: ${_trip['scheduledPickupLabel']}',
                      style: const TextStyle(fontSize: 13, color: Colors.grey),
                    ),
                  ],
                  const SizedBox(height: 10),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _driverAvatar(initial),
                      const SizedBox(width: 12),
                      Expanded(child: Center(child: _vehicleImage())),
                      const SizedBox(width: 12),
                      SizedBox(
                        width: 136,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(
                              _driverPlate,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: Colors.black,
                                fontSize: 22,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            const SizedBox(height: 3),
                            SizedBox(
                              width: 136,
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
                                    color: Color(0xFF4F4F4F),
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
                      color: Colors.black,
                      fontSize: 19,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  const Text(
                    'Conductor asignado',
                    style: TextStyle(color: Color(0xFF9D9D9D), fontSize: 12),
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
                            foregroundColor: Colors.black,
                            side: const BorderSide(color: Colors.black26),
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
                              foregroundColor: const Color(0xFFFF7777),
                              side: const BorderSide(color: Color(0xFF8F3E3E)),
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
          ),
        ],
      ),
    );
  }
}
