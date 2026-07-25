import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:permission_handler/permission_handler.dart';
import '../services/directions_service.dart';
import '../services/passenger_service.dart';
import '../services/places_service.dart';
import '../services/trip_service.dart';
import 'destination_picker_screen.dart';
import 'place_search_screen.dart';

/// Pantalla principal, estilo Uber: mapa a pantalla completa, tarjeta de
/// busqueda flotando arriba (partida/destino) y un panel inferior fijo con
/// el boton de confirmar. El pasajero busca sus puntos por nombre (Places
/// Autocomplete) y puede ajustar el pin de recogida a mano si hace falta.
class RequestRideScreen extends StatefulWidget {
  final void Function(String tripId) onRequested;
  final LatLng? initialPickup;
  final LatLng? initialDestination;
  final String? initialDestinationLabel;

  const RequestRideScreen({
    super.key,
    required this.onRequested,
    this.initialPickup,
    this.initialDestination,
    this.initialDestinationLabel,
  });

  @override
  State<RequestRideScreen> createState() => _RequestRideScreenState();
}

class _RequestRideScreenState extends State<RequestRideScreen> {
  GoogleMapController? _mapController;
  LatLng _pickup = const LatLng(19.4326, -99.1332);
  String _pickupLabel = 'Mi ubicación actual';
  LatLng? _destination;
  String? _destinationLabel;
  bool _loadingLocation = true;
  bool _requesting = false;
  String? _error;
  bool _showMap = false;
  bool _mapReady = false;
  List<LatLng> _routePoints = [];
  TimeOfDay? _scheduledTime;

  @override
  void initState() {
    super.initState();
    _destination = widget.initialDestination;
    _destinationLabel = widget.initialDestinationLabel;
    if (widget.initialPickup != null) {
      _pickup = widget.initialPickup!;
      _loadingLocation = false;
    } else {
      _locateMe();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _showMap = true);
    });
  }

  Future<void> _loadRoute() async {
    if (_destination == null) {
      setState(() => _routePoints = []);
      return;
    }
    final destination = _destination!;
    try {
      final route = await DirectionsService.getRoute(_pickup, destination);
      if (!mounted || _destination != destination) return;
      setState(() => _routePoints = route);
    } catch (_) {
      if (!mounted || _destination != destination) return;
      setState(() => _routePoints = [_pickup, destination]);
    }
    _fitBounds();
  }

  void _fitBounds() {
    if (_destination == null || _mapController == null) return;
    final points = _routePoints.length >= 2 ? _routePoints : [_pickup, _destination!];
    double minLat = points.first.latitude, maxLat = points.first.latitude;
    double minLng = points.first.longitude, maxLng = points.first.longitude;
    for (final p in points) {
      if (p.latitude < minLat) minLat = p.latitude;
      if (p.latitude > maxLat) maxLat = p.latitude;
      if (p.longitude < minLng) minLng = p.longitude;
      if (p.longitude > maxLng) maxLng = p.longitude;
    }
    _mapController!.animateCamera(
      CameraUpdate.newLatLngBounds(
        LatLngBounds(southwest: LatLng(minLat, minLng), northeast: LatLng(maxLat, maxLng)),
        80,
      ),
    );
  }

  Future<void> _locateMe() async {
    try {
      final permission = await Permission.locationWhenInUse.request();
      if (permission.isGranted) {
        final position = await Geolocator.getCurrentPosition();
        setState(() => _pickup = LatLng(position.latitude, position.longitude));
        _mapController?.animateCamera(CameraUpdate.newLatLng(_pickup));
      }
    } catch (_) {
      // Se queda con la posicion por defecto; el usuario puede buscar o arrastrar el pin.
    } finally {
      setState(() => _loadingLocation = false);
    }
  }

  Future<void> _searchPickup() async {
    final result = await Navigator.push<PlaceSearchResult>(
      context,
      MaterialPageRoute(
        builder: (_) => const PlaceSearchScreen(title: 'Punto de partida', hint: '¿Dónde te recogemos?'),
      ),
    );
    if (result == null) return;
    final latLng = LatLng(result.lat, result.lng);
    setState(() { _pickup = latLng; _pickupLabel = result.description; });
    if (_destination != null) {
      _loadRoute();
    } else {
      _mapController?.animateCamera(CameraUpdate.newLatLng(latLng));
    }
  }

  Future<void> _searchDestination() async {
    final result = await Navigator.push<DestinationPickerResult>(
      context,
      MaterialPageRoute(
        builder: (_) => DestinationPickerScreen(initialCenter: _pickup, pickupLabel: _pickupLabel),
      ),
    );
    if (result == null) return;
    final latLng = LatLng(result.lat, result.lng);
    setState(() { _destination = latLng; _destinationLabel = result.description; });
    _loadRoute();
  }

  // Formato 12h AM/PM fijo, sin depender de la configuracion regional del
  // telefono (a diferencia de TimeOfDay.format(context), que usa 24h si el
  // locale del dispositivo lo hace).
  static String _formatTime12h(TimeOfDay time) {
    final hour12 = time.hourOfPeriod == 0 ? 12 : time.hourOfPeriod;
    final minute = time.minute.toString().padLeft(2, '0');
    final period = time.period == DayPeriod.am ? 'AM' : 'PM';
    return '$hour12:$minute $period';
  }

  Future<void> _pickScheduledTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _scheduledTime ?? TimeOfDay.now(),
      // Forzado a 12h AM/PM aunque el telefono este en formato 24h.
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(alwaysUse24HourFormat: false),
        child: child!,
      ),
    );
    if (picked != null) setState(() => _scheduledTime = picked);
  }

  // Solo se elige la hora (no la fecha): si ya paso por hoy, se asume que
  // es para mañana a esa hora -- evita pedir un despacho "programado" en
  // el pasado.
  DateTime _scheduledDateTime(TimeOfDay time) {
    final now = DateTime.now();
    var candidate = DateTime(now.year, now.month, now.day, time.hour, time.minute);
    if (candidate.isBefore(now)) candidate = candidate.add(const Duration(days: 1));
    return candidate;
  }

  // "Mi ubicación actual" y "Punto marcado en el mapa" son etiquetas
  // genericas que se muestran en la caja de busqueda, no direcciones
  // reales -- si se guardan tal cual en el viaje, el historial (Actividad)
  // termina mostrando eso en vez de decir de donde salio en verdad. Antes
  // de pedir el viaje se reemplazan por la direccion real via geocoding
  // inverso.
  static const _genericPickupLabels = {'Mi ubicación actual', 'Punto marcado en el mapa'};

  Future<void> _requestRide() async {
    setState(() { _requesting = true; _error = null; });
    try {
      var pickupAddress = _pickupLabel;
      if (_genericPickupLabels.contains(pickupAddress)) {
        try {
          pickupAddress = await PlacesService.reverseGeocode(_pickup.latitude, _pickup.longitude);
        } catch (_) {
          // Se queda con la etiqueta generica si el geocoding falla.
        }
      }
      final profile = await PassengerService.cachedProfile();
      final tripId = await TripService.requestRide(
        pickupLat: _pickup.latitude,
        pickupLng: _pickup.longitude,
        pickupAddress: pickupAddress,
        destinationLat: _destination?.latitude,
        destinationLng: _destination?.longitude,
        destinationAddress: _destinationLabel,
        passengerName: profile?['name'] ?? 'Pasajero',
        passengerPhone: profile?['phone'] ?? '',
        scheduledPickupLabel:
            _scheduledTime != null ? _formatTime12h(_scheduledTime!) : null,
        scheduledPickupAt: _scheduledTime != null
            ? _scheduledDateTime(_scheduledTime!).millisecondsSinceEpoch
            : null,
      );
      widget.onRequested(tripId);
      if (mounted) Navigator.pop(context, tripId);
    } catch (e) {
      setState(() { _requesting = false; _error = 'Error al pedir el viaje: $e'; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      extendBodyBehindAppBar: true,
      body: Stack(
        children: [
          Positioned.fill(
            child: (_loadingLocation || !_showMap)
                ? const Center(child: CircularProgressIndicator(color: Colors.black))
                : Opacity(
                    opacity: _mapReady ? 1 : 0,
                    child: GoogleMap(
                      initialCameraPosition: CameraPosition(target: _pickup, zoom: 15),
                      onMapCreated: (controller) {
                        _mapController = controller;
                        Future.delayed(const Duration(milliseconds: 300), () {
                          if (!mounted) return;
                          setState(() => _mapReady = true);
                          if (_destination != null) _loadRoute();
                        });
                      },
                      myLocationEnabled: true,
                      myLocationButtonEnabled: false,
                      zoomControlsEnabled: false,
                      padding: const EdgeInsets.only(bottom: 220),
                      polylines: _routePoints.length >= 2
                          ? {
                              Polyline(
                                polylineId: const PolylineId('route'),
                                points: _routePoints,
                                color: Colors.black,
                                width: 4,
                              ),
                            }
                          : {},
                      markers: {
                        Marker(
                          markerId: const MarkerId('pickup'),
                          position: _pickup,
                          draggable: true,
                          onDragEnd: (latLng) {
                            setState(() {
                              _pickup = latLng;
                              _pickupLabel = 'Punto marcado en el mapa';
                            });
                            if (_destination != null) _loadRoute();
                          },
                          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
                          infoWindow: const InfoWindow(title: 'Punto de recogida'),
                        ),
                        if (_destination != null)
                          Marker(
                            markerId: const MarkerId('destination'),
                            position: _destination!,
                            icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueViolet),
                            infoWindow: const InfoWindow(title: 'Destino'),
                          ),
                      },
                    ),
                  ),
          ),
          if (!_mapReady && !_loadingLocation && _showMap)
            const Positioned.fill(
              child: ColoredBox(
                color: Colors.white,
                child: Center(child: CircularProgressIndicator(color: Colors.black)),
              ),
            ),
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: _buildSearchCard(),
              ),
            ),
          ),
          _buildBottomPanel(),
        ],
      ),
    );
  }

  Widget _buildBottomPanel() {
    return Positioned(
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
            const Text('Tu viaje', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 12),
            InkWell(
              onTap: _pickScheduledTime,
              borderRadius: BorderRadius.circular(8),
              child: Row(
                children: [
                  const Icon(Icons.schedule, size: 16, color: Colors.black87),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Text(
                      _scheduledTime != null
                          ? 'Recogida: ${_formatTime12h(_scheduledTime!)}'
                          : 'Recogida: Ahora',
                      style: const TextStyle(fontSize: 14, color: Colors.black87),
                    ),
                  ),
                  if (_scheduledTime != null)
                    IconButton(
                      icon: const Icon(Icons.close, size: 16),
                      onPressed: () => setState(() => _scheduledTime = null),
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(),
                    ),
                ],
              ),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 4),
              child: Divider(height: 20),
            ),
            if (_error != null) ...[
              Text(_error!, style: const TextStyle(color: Colors.red)),
              const SizedBox(height: 8),
            ],
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: (_requesting || _destination == null) ? null : _requestRide,
                style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                child: _requesting
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : Text(
                        _destination == null
                            ? 'Elige un destino'
                            : (_scheduledTime != null ? 'Programar viaje' : 'Confirmar viaje'),
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSearchCard() {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 12, offset: Offset(0, 2))],
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        children: [
          _searchField(
            icon: Icons.radio_button_checked,
            iconColor: Colors.black,
            label: _pickupLabel,
            onTap: _searchPickup,
          ),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 4),
            child: Divider(height: 16),
          ),
          _searchField(
            icon: Icons.square_rounded,
            iconColor: Colors.black,
            label: _destinationLabel ?? '¿A dónde vas?',
            placeholder: _destinationLabel == null,
            onTap: _searchDestination,
          ),
        ],
      ),
    );
  }

  Widget _searchField({
    required IconData icon,
    required Color iconColor,
    required String label,
    required VoidCallback onTap,
    bool placeholder = false,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Row(
        children: [
          Icon(icon, color: iconColor, size: 16),
          const SizedBox(width: 14),
          Expanded(
            child: Text(
              label,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 15,
                color: placeholder ? Colors.black45 : Colors.black87,
                fontWeight: placeholder ? FontWeight.normal : FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
