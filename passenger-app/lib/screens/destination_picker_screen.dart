import 'dart:async';
import 'package:geolocator/geolocator.dart';
import 'package:flutter/material.dart';
import '../services/places_service.dart';
import '../services/map_adapter.dart';
import '../theme/app_theme.dart';
import '../services/trip_service.dart';

class DestinationPickerResult {
  final String description;
  final double lat;
  final double lng;
  DestinationPickerResult({
    required this.description,
    required this.lat,
    required this.lng,
  });
}

/// Pantalla de destino: tarjetas blancas flotantes sobre el mapa (que se ve
/// de fondo en todo momento, incluso entre tarjetas). Arriba, la caja
/// combinada origen/destino; abajo, una tarjeta con la busqueda / los
/// ultimos 3 destinos usados / la opcion de marcar el punto a mano en el
/// mapa.
class DestinationPickerScreen extends StatefulWidget {
  final LatLng initialCenter;
  final String pickupLabel;

  const DestinationPickerScreen({
    super.key,
    required this.initialCenter,
    this.pickupLabel = 'Mi ubicación actual',
  });

  @override
  State<DestinationPickerScreen> createState() =>
      _DestinationPickerScreenState();
}

class _DestinationPickerScreenState extends State<DestinationPickerScreen> {
  MapboxMapController? _mapController;
  final _controller = TextEditingController();
  final _sessionToken = PlacesService.newSessionToken();
  Timer? _debounce;
  Timer? _reverseDebounce;
  int _searchGeneration = 0;
  LatLng? _lastReverseRequested;
  int _reverseRequestToken = 0;
  List<PlaceSuggestion> _suggestions = [];
  bool _loading = false;
  String? _error;

  LatLng _cameraCenter;
  // _showMap se activa recien en el primer frame ya pintado (post-frame
  // callback) para que la vista nativa del mapa (platform view) no se
  // adjunte durante el layout inicial -- adjuntarla antes de tiempo es lo
  // que causaba el parpadeo negro/rosado al abrir esta pantalla.
  bool _showMap = false;
  bool _mapReady = false;
  LatLng? _pin;
  String? _pinLabel;
  // true solo cuando el pin se puso tocando/arrastrando el mapa (o con
  // "Establece la ubicacion en el mapa") a mano -- en ese caso no se
  // confirma solo, se espera a que el usuario revise la posicion y presione
  // "Confirmar destino". Buscar o elegir un reciente confirma de inmediato.
  bool _manualPin = false;
  // Modo "Fija tu destino": el pin queda fijo en el centro de la pantalla
  // y es el MAPA el que se arrastra debajo -- igual que la app de
  // referencia. Mucho mas facil de usar que arrastrar un marcador chico.
  bool _pinningMode = false;

  _DestinationPickerScreenState() : _cameraCenter = const LatLng(0, 0);

  late Future<List<({String label, double lat, double lng})>> _recentFuture;

  @override
  void initState() {
    super.initState();
    _cameraCenter = widget.initialCenter;
    _recentFuture = TripService.getRecentDestinations(limit: 3);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _showMap = true);
    });
  }

  @override
  void dispose() {
    _searchGeneration++;
    _debounce?.cancel();
    _reverseDebounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    final generation = ++_searchGeneration;
    _debounce = Timer(
      const Duration(milliseconds: 400),
      () => _search(value, generation),
    );
  }

  Future<void> _search(String value, int generation) async {
    if (!mounted || generation != _searchGeneration) return;
    if (value.trim().isEmpty) {
      setState(() {
        _suggestions = [];
        _error = null;
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await PlacesService.autocomplete(value, _sessionToken);
      if (mounted && generation == _searchGeneration) {
        setState(() {
          _suggestions = results;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted && generation == _searchGeneration) {
        setState(() {
          _loading = false;
          _error = 'Error al buscar: $e';
        });
      }
    }
  }

  Future<void> _selectSuggestion(PlaceSuggestion suggestion) async {
    _searchGeneration++;
    setState(() {
      _loading = true;
      _suggestions = [];
    });
    _controller.text = suggestion.description;
    try {
      final latLng = await PlacesService.getPlaceLatLng(
        suggestion.placeId,
        _sessionToken,
      );
      if (!mounted) return;
      final target = LatLng(latLng.lat, latLng.lng);
      setState(() {
        _loading = false;
        _pin = target;
        _pinLabel = suggestion.description;
      });
      _mapController?.animateCamera(CameraUpdate.newLatLngZoom(target, 16));
      _confirm();
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = 'Error al obtener el lugar: $e';
        });
      }
    }
  }

  void _selectRecent(({String label, double lat, double lng}) recent) {
    final target = LatLng(recent.lat, recent.lng);
    setState(() {
      _pin = target;
      _pinLabel = recent.label;
      _controller.text = recent.label;
    });
    _mapController?.animateCamera(CameraUpdate.newLatLngZoom(target, 16));
    _confirm();
  }

  void _onMapTap(LatLng latLng) {
    setState(() {
      _pin = latLng;
      _pinLabel = 'Ubicando dirección...';
      _manualPin = true;
      _controller.clear();
      _suggestions = [];
    });
    _reverseGeocodePin(latLng);
  }

  void _onPinDragEnd(LatLng latLng) {
    setState(() {
      _pin = latLng;
      _pinLabel = 'Ubicando dirección...';
      _manualPin = true;
    });
    _reverseGeocodePin(latLng);
  }

  /// "Establece la ubicacion en el mapa": entra al modo "Fija tu destino",
  /// con el pin fijo en el centro de la pantalla y el mapa arrastrable
  /// debajo (en vez de arrastrar un marcador chico, que es mas dificil de
  /// controlar con precision).
  void _enterPinningMode() {
    setState(() {
      _pinningMode = true;
      _manualPin = true;
      _pin = _cameraCenter;
      _pinLabel = null;
      _controller.clear();
      _suggestions = [];
    });
    _reverseGeocodePin(_cameraCenter);
  }

  void _exitPinningMode() {
    setState(() => _pinningMode = false);
  }

  void _onCameraIdle() {
    if (!_pinningMode) return;
    final center = _cameraCenter;
    setState(() {
      _pin = center;
      _pinLabel = null;
    });
    _reverseGeocodePin(center);
  }

  Future<void> _reverseGeocodePin(LatLng latLng) async {
    _reverseDebounce?.cancel();
    final last = _lastReverseRequested;
    if (last != null &&
        Geolocator.distanceBetween(
              last.latitude,
              last.longitude,
              latLng.latitude,
              latLng.longitude,
            ) <
            60) {
      return;
    }
    final requestToken = ++_reverseRequestToken;
    _reverseDebounce = Timer(const Duration(milliseconds: 500), () async {
      try {
        final address = await PlacesService.reverseGeocode(
          latLng.latitude,
          latLng.longitude,
        );
        if (!mounted ||
            requestToken != _reverseRequestToken ||
            _pin != latLng) {
          return;
        }
        _lastReverseRequested = latLng;
        setState(() {
          _pinLabel = address;
          _controller.text = address;
        });
      } catch (_) {
        if (!mounted ||
            requestToken != _reverseRequestToken ||
            _pin != latLng) {
          return;
        }
        _lastReverseRequested = latLng;
        setState(() => _pinLabel = 'Punto marcado en el mapa');
      }
    });
  }

  void _confirm() {
    if (_pin == null) return;
    Navigator.pop(
      context,
      DestinationPickerResult(
        description: _pinLabel ?? 'Destino',
        lat: _pin!.latitude,
        lng: _pin!.longitude,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.paper,
      body: Stack(
        children: [
          if (_showMap)
            Positioned.fill(
              child: Opacity(
                opacity: _mapReady ? 1 : 0,
                child: MapboxMapView(
                  initialCameraPosition: CameraPosition(
                    target: widget.initialCenter,
                    zoom: 14,
                  ),
                  onMapCreated: (controller) {
                    _mapController = controller;
                    Future.delayed(const Duration(milliseconds: 300), () {
                      if (mounted) setState(() => _mapReady = true);
                    });
                  },
                  onCameraMove: (position) => _cameraCenter = position.target,
                  onCameraIdle: _onCameraIdle,
                  onTap: _pinningMode ? null : _onMapTap,
                  zoomControlsEnabled: false,
                  myLocationButtonEnabled: false,
                  markers: (_pin == null || _pinningMode)
                      ? {}
                      : {
                          Marker(
                            markerId: const MarkerId('destination'),
                            position: _pin!,
                            draggable: true,
                            onDragEnd: _onPinDragEnd,
                            icon: BitmapDescriptor.defaultMarkerWithHue(
                              BitmapDescriptor.hueViolet,
                            ),
                          ),
                        },
                ),
              ),
            ),
          if (!_mapReady)
            const Positioned.fill(
              child: ColoredBox(
                color: AppColors.paper,
                child: Center(
                  child: CircularProgressIndicator(color: AppColors.ink),
                ),
              ),
            ),
          if (_pinningMode)
            IgnorePointer(
              child: Center(
                child: Transform.translate(
                  offset: const Offset(0, -24),
                  child: const Icon(
                    Icons.location_on,
                    size: 48,
                    color: AppColors.ink,
                  ),
                ),
              ),
            ),
          if (_pinningMode)
            Positioned(
              top: MediaQuery.of(context).padding.top + 12,
              left: 16,
              child: _circleButton(
                icon: Icons.arrow_back,
                onPressed: _exitPinningMode,
              ),
            ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
              child: _pinningMode
                  ? Column(children: [const Spacer(), _buildPinningPanel()])
                  : Column(
                      children: [
                        _buildTopCard(),
                        const SizedBox(height: 12),
                        Expanded(child: _buildListCard()),
                        if (_manualPin && _pin != null) ...[
                          const SizedBox(height: 12),
                          _buildConfirmCard(),
                        ],
                      ],
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _circleButton({
    required IconData icon,
    required VoidCallback onPressed,
  }) {
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.paper,
        shape: BoxShape.circle,
        boxShadow: [
          BoxShadow(
            color: Colors.black26,
            blurRadius: 10,
            offset: Offset(0, 2),
          ),
        ],
      ),
      child: IconButton(
        icon: Icon(icon, color: AppColors.ink),
        onPressed: onPressed,
      ),
    );
  }

  Widget _buildPinningPanel() {
    return _floatingCard(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(
                color: Colors.black12,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const Text(
            'Fija tu destino',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.bold,
              color: Colors.black,
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'Arrastra el mapa para mover el marcador',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13, color: Colors.black54),
          ),
          const SizedBox(height: 16),
          const Divider(height: 1, color: Colors.black12),
          const SizedBox(height: 12),
          InkWell(
            onTap: _exitPinningMode,
            borderRadius: BorderRadius.circular(12),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
              decoration: BoxDecoration(
                color: Colors.grey.shade100,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                children: const [
                  Icon(Icons.square_rounded, size: 14, color: Colors.black87),
                  SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      '¿A dónde vas?',
                      style: TextStyle(color: Colors.black45, fontSize: 15),
                    ),
                  ),
                  Icon(Icons.search, color: Colors.black45),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          ElevatedButton(
            // _pinLabel es null mientras el geocoding inverso todavia esta
            // resolviendo la direccion real del punto marcado -- si se
            // permite confirmar en ese instante, _confirm() cae al fallback
            // literal 'Destino' (ver mas abajo) en vez de guardar el lugar
            // real.
            onPressed: (_pin == null || _pinLabel == null) ? null : _confirm,
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.ink,
              foregroundColor: AppColors.paper,
              minimumSize: const Size.fromHeight(52),
            ),
            child: Text(
              _pinLabel == null ? 'Buscando dirección...' : 'Confirmar destino',
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }

  Widget _floatingCard({required Widget child, EdgeInsetsGeometry? padding}) {
    return Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: AppColors.paper,
        borderRadius: BorderRadius.circular(20),
        boxShadow: const [
          BoxShadow(
            color: Colors.black26,
            blurRadius: 16,
            offset: Offset(0, 4),
          ),
        ],
      ),
      child: child,
    );
  }

  Widget _buildTopCard() {
    return _floatingCard(
      padding: const EdgeInsets.fromLTRB(4, 4, 4, 14),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back, color: AppColors.ink),
                onPressed: () => Navigator.pop(context),
              ),
              const Expanded(
                child: Text(
                  'Pedir un viaje',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: Colors.black,
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              const SizedBox(width: 48),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Container(
              decoration: BoxDecoration(
                color: AppColors.paperMuted,
                borderRadius: BorderRadius.circular(14),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
              child: Row(
                children: [
                  Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const SizedBox(height: 18),
                      Container(
                        width: 8,
                        height: 8,
                        decoration: const BoxDecoration(
                          color: Colors.black87,
                          shape: BoxShape.circle,
                        ),
                      ),
                      Container(width: 1, height: 26, color: Colors.black26),
                      Container(width: 8, height: 8, color: Colors.black87),
                    ],
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(
                          height: 44,
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: Text(
                              widget.pickupLabel,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: Colors.black87,
                                fontSize: 15,
                              ),
                            ),
                          ),
                        ),
                        const Divider(height: 1, color: Colors.black12),
                        SizedBox(
                          height: 44,
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: TextField(
                              controller: _controller,
                              autofocus: true,
                              style: const TextStyle(
                                color: Colors.black,
                                fontSize: 15,
                              ),
                              decoration: const InputDecoration(
                                hintText: '¿A dónde vas?',
                                hintStyle: TextStyle(color: Colors.black38),
                                border: InputBorder.none,
                                isDense: true,
                              ),
                              onChanged: _onChanged,
                            ),
                          ),
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

  Widget _buildConfirmCard() {
    return _floatingCard(
      padding: const EdgeInsets.all(12),
      child: SizedBox(
        width: double.infinity,
        child: ElevatedButton(
          onPressed: _confirm,
          style: ElevatedButton.styleFrom(
            backgroundColor: AppColors.ink,
            foregroundColor: AppColors.paper,
            minimumSize: const Size.fromHeight(52),
          ),
          child: const Text(
            'Confirmar destino',
            style: TextStyle(fontWeight: FontWeight.w600),
          ),
        ),
      ),
    );
  }

  Widget _buildListCard() {
    return _floatingCard(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: _buildListArea(),
    );
  }

  Widget _buildListArea() {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Center(child: CircularProgressIndicator(color: AppColors.ink)),
      );
    }
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Text(_error!, style: const TextStyle(color: Colors.red)),
      );
    }
    if (_suggestions.isNotEmpty) {
      return ListView.separated(
        padding: EdgeInsets.zero,
        itemCount: _suggestions.length,
        separatorBuilder: (_, _) =>
            const Divider(height: 1, color: Colors.black12),
        itemBuilder: (context, index) {
          final s = _suggestions[index];
          return ListTile(
            leading: const Icon(Icons.place_outlined, color: Colors.black54),
            title: Text(
              s.description,
              style: const TextStyle(color: Colors.black),
            ),
            onTap: () => _selectSuggestion(s),
          );
        },
      );
    }

    // Sin busqueda activa: opcion de marcar en el mapa + los ultimos 3
    // destinos usados.
    return FutureBuilder<List<({String label, double lat, double lng})>>(
      future: _recentFuture,
      builder: (context, snapshot) {
        final recent = snapshot.connectionState == ConnectionState.done
            ? (snapshot.data ?? [])
            : <({String label, double lat, double lng})>[];
        return ListView(
          padding: EdgeInsets.zero,
          children: [
            ListTile(
              leading: const Icon(
                Icons.edit_location_alt_outlined,
                color: Colors.black87,
              ),
              title: const Text(
                'Establece la ubicación en el mapa',
                style: TextStyle(
                  color: Colors.black,
                  fontWeight: FontWeight.w500,
                ),
              ),
              onTap: _enterPinningMode,
            ),
            if (recent.isNotEmpty) ...[
              const Divider(height: 1, color: Colors.black12),
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Text(
                  'Recientes',
                  style: TextStyle(
                    color: Colors.black54,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              for (final r in recent)
                ListTile(
                  leading: const Icon(Icons.history, color: Colors.black54),
                  title: Text(
                    r.label,
                    style: const TextStyle(color: Colors.black),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  onTap: () => _selectRecent(r),
                ),
            ],
          ],
        );
      },
    );
  }
}
