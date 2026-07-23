import 'dart:async';
import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../services/trip_service.dart';
import '../widgets/support_button.dart';

/// Se muestra mientras el viaje esta en 'searching' (buscando conductor) o
/// 'no_drivers_available'. La asignacion es automatica: en cuanto Cloud
/// Functions encuentra un conductor, el viaje pasa directo a 'accepted' y
/// el padre (PassengerHomePage) cambia a ActiveTripTrackingScreen, que ya
/// muestra el nombre/placa/telefono/ubicacion del conductor asignado.
///
/// Mismo lenguaje visual que las demas pantallas del viaje: mapa a pantalla
/// completa con un panel inferior fijo.
class SearchingScreen extends StatefulWidget {
  final String tripId;
  final Map<String, dynamic> trip;
  final void Function(Map<String, dynamic> trip) onStatusChanged;
  final VoidCallback onCancelled;

  const SearchingScreen({
    super.key,
    required this.tripId,
    required this.trip,
    required this.onStatusChanged,
    required this.onCancelled,
  });

  @override
  State<SearchingScreen> createState() => _SearchingScreenState();
}

class _SearchingScreenState extends State<SearchingScreen> {
  Timer? _timer;
  late Map<String, dynamic> _trip;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _trip = widget.trip;
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => _poll());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _poll() async {
    try {
      final trip = await TripService.getTrip(widget.tripId);
      if (trip == null) return;
      if (trip['status'] != _trip['status']) {
        widget.onStatusChanged(trip);
        return;
      }
      if (mounted) setState(() => _trip = trip);
    } catch (_) {
      // Reintenta en el siguiente tick.
    }
  }

  Future<void> _retry() async {
    setState(() => _busy = true);
    try {
      await TripService.retrySearch(widget.tripId);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _cancel() async {
    setState(() => _busy = true);
    try {
      await TripService.cancelTrip(widget.tripId);
      widget.onCancelled();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final noDrivers = _trip['status'] == 'no_drivers_available';
    final pickup = LatLng(
      (_trip['pickupLat'] as num).toDouble(),
      (_trip['pickupLng'] as num).toDouble(),
    );

    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: GoogleMap(
              initialCameraPosition: CameraPosition(target: pickup, zoom: 15),
              myLocationButtonEnabled: false,
              zoomControlsEnabled: false,
              scrollGesturesEnabled: false,
              zoomGesturesEnabled: false,
              padding: const EdgeInsets.only(bottom: 260),
              markers: {
                Marker(
                  markerId: const MarkerId('pickup'),
                  position: pickup,
                  icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
                ),
              },
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
              padding: EdgeInsets.fromLTRB(24, 28, 24, MediaQuery.of(context).padding.bottom + 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (!noDrivers) ...[
                    const SizedBox(
                      height: 40,
                      width: 40,
                      child: CircularProgressIndicator(color: Colors.black, strokeWidth: 3),
                    ),
                    const SizedBox(height: 20),
                    const Text(
                      'Buscando el conductor más cercano...',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                    ),
                  ] else ...[
                    const Icon(Icons.info_outline, size: 40, color: Colors.black54),
                    const SizedBox(height: 16),
                    const Text(
                      'No hay conductores disponibles en este momento.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 20),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: _busy ? null : _retry,
                        style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                        child: const Text('Reintentar'),
                      ),
                    ),
                  ],
                  const SizedBox(height: 12),
                  TextButton(
                    onPressed: _busy ? null : _cancel,
                    child: const Text('Cancelar viaje', style: TextStyle(color: Colors.red)),
                  ),
                ],
              ),
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
        ],
      ),
    );
  }
}
