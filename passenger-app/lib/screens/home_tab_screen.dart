import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:permission_handler/permission_handler.dart';
import 'destination_picker_screen.dart';
import 'preset_places_screen.dart';
import 'request_ride_screen.dart';
import '../widgets/support_button.dart';

/// Pestaña "Inicio": mapa de fondo centrado en la ubicacion actual, con el
/// buscador de destino flotando arriba (igual que las apps de viajes
/// conocidas). Al elegir destino pasa a RequestRideScreen ya con el
/// destino puesto, donde se confirma el punto de recogida y se pide el
/// viaje.
class HomeTabScreen extends StatefulWidget {
  final void Function(String tripId) onRequested;

  const HomeTabScreen({super.key, required this.onRequested});

  @override
  State<HomeTabScreen> createState() => _HomeTabScreenState();
}

class _HomeTabScreenState extends State<HomeTabScreen> {
  GoogleMapController? _mapController;
  LatLng _pickup = const LatLng(19.4326, -99.1332);
  bool _loadingLocation = true;
  bool _showMap = false;
  bool _mapReady = false;

  @override
  void initState() {
    super.initState();
    _locateMe();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _showMap = true);
    });
  }

  Future<void> _locateMe() async {
    try {
      final permission = await Permission.locationWhenInUse.request();
      if (permission.isGranted) {
        final position = await Geolocator.getCurrentPosition();
        if (mounted) {
          setState(() => _pickup = LatLng(position.latitude, position.longitude));
          _mapController?.animateCamera(CameraUpdate.newLatLng(_pickup));
        }
      }
    } catch (_) {
      // Se queda con la posicion por defecto.
    } finally {
      if (mounted) setState(() => _loadingLocation = false);
    }
  }

  Future<void> _openDestinationSearch() async {
    final result = await Navigator.push<DestinationPickerResult>(
      context,
      MaterialPageRoute(
        builder: (_) => DestinationPickerScreen(initialCenter: _pickup),
      ),
    );
    if (result != null) await _requestWithDestination(result);
  }

  Future<void> _openPresetPlaces(String title, String configKey) async {
    final result = await Navigator.push<DestinationPickerResult>(
      context,
      MaterialPageRoute(
        builder: (_) => PresetPlacesScreen(title: title, configKey: configKey),
      ),
    );
    if (result != null) await _requestWithDestination(result);
  }

  Future<void> _requestWithDestination(DestinationPickerResult result) async {
    if (!mounted) return;
    final tripId = await Navigator.push<String>(
      context,
      MaterialPageRoute(
        builder: (_) => RequestRideScreen(
          onRequested: (id) {},
          initialPickup: _pickup,
          initialDestination: LatLng(result.lat, result.lng),
          initialDestinationLabel: result.description,
        ),
      ),
    );
    if (tripId != null) widget.onRequested(tripId);
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
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
                        if (mounted) setState(() => _mapReady = true);
                      });
                    },
                    myLocationEnabled: true,
                    myLocationButtonEnabled: false,
                    zoomControlsEnabled: false,
                    markers: {
                      Marker(markerId: const MarkerId('pickup'), position: _pickup),
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
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Text(
                      'Pedir un viaje',
                      style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
                    ),
                  ),
                  const SizedBox(height: 12),
                  InkWell(
                    onTap: _openDestinationSearch,
                    borderRadius: BorderRadius.circular(14),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(14),
                        boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 12, offset: Offset(0, 2))],
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.search, color: Colors.black87),
                          const SizedBox(width: 12),
                          Text(
                            '¿A dónde vas?',
                            style: TextStyle(fontSize: 16, color: Colors.grey.shade700),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
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
        Positioned(
          left: 16,
          right: 16,
          bottom: 16,
          child: SafeArea(
            top: false,
            child: Row(
              children: [
                Expanded(
                  child: FloatingActionButton.extended(
                    heroTag: 'sport-venues-fab',
                    backgroundColor: Colors.white,
                    foregroundColor: Colors.black,
                    icon: const Icon(Icons.sports_soccer, size: 20),
                    label: const Text(
                      'Sedes deportivas',
                      overflow: TextOverflow.ellipsis,
                      maxLines: 1,
                      style: TextStyle(fontSize: 13),
                    ),
                    onPressed: () => _openPresetPlaces('Sedes deportivas', 'sportVenues'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FloatingActionButton.extended(
                    heroTag: 'hotels-fab',
                    backgroundColor: Colors.white,
                    foregroundColor: Colors.black,
                    icon: const Icon(Icons.hotel, size: 20),
                    label: const Text(
                      'Hoteles',
                      overflow: TextOverflow.ellipsis,
                      maxLines: 1,
                      style: TextStyle(fontSize: 13),
                    ),
                    onPressed: () => _openPresetPlaces('Hoteles', 'hotels'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
