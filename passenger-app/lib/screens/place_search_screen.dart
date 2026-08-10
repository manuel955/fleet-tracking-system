import 'dart:async';
import 'package:flutter/material.dart';
import '../services/places_service.dart';
import '../theme/app_theme.dart';

class PlaceSearchResult {
  final String description;
  final double lat;
  final double lng;
  PlaceSearchResult({
    required this.description,
    required this.lat,
    required this.lng,
  });
}

/// Pantalla de busqueda de direcciones (Places Autocomplete). Se abre desde
/// los campos de "Punto de partida" / "Destino" en RequestRideScreen y
/// devuelve el lugar elegido via Navigator.pop.
class PlaceSearchScreen extends StatefulWidget {
  final String title;
  final String hint;

  const PlaceSearchScreen({super.key, required this.title, required this.hint});

  @override
  State<PlaceSearchScreen> createState() => _PlaceSearchScreenState();
}

class _PlaceSearchScreenState extends State<PlaceSearchScreen> {
  final _controller = TextEditingController();
  final _sessionToken = PlacesService.newSessionToken();
  Timer? _debounce;
  List<PlaceSuggestion> _suggestions = [];
  bool _loading = false;
  String? _error;

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () => _search(value));
  }

  Future<void> _search(String value) async {
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
      if (mounted) {
        setState(() {
          _suggestions = results;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = 'Error al buscar: $e';
        });
      }
    }
  }

  Future<void> _selectSuggestion(PlaceSuggestion suggestion) async {
    setState(() => _loading = true);
    try {
      final latLng = await PlacesService.getPlaceLatLng(
        suggestion.placeId,
        _sessionToken,
      );
      if (mounted) {
        Navigator.pop(
          context,
          PlaceSearchResult(
            description: suggestion.description,
            lat: latLng.lat,
            lng: latLng.lng,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = 'Error al obtener el lugar: $e';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.paper,
      appBar: AppBar(
        titleSpacing: 0,
        title: Container(
          height: 44,
          margin: const EdgeInsets.only(right: 16),
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: AppColors.paperMuted,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              Icon(Icons.search, size: 18, color: AppColors.muted),
              const SizedBox(width: 10),
              Expanded(
                child: TextField(
                  controller: _controller,
                  autofocus: true,
                  decoration: InputDecoration(
                    hintText: widget.hint,
                    hintStyle: const TextStyle(color: AppColors.muted),
                    border: InputBorder.none,
                    isDense: true,
                  ),
                  style: const TextStyle(fontSize: 15, color: AppColors.ink),
                  onChanged: _onChanged,
                ),
              ),
            ],
          ),
        ),
      ),
      body: Column(
        children: [
          if (_loading)
            const LinearProgressIndicator(
              color: AppColors.ink,
              backgroundColor: AppColors.paperMuted,
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                _error!,
                style: TextStyle(color: Colors.red.shade700, fontSize: 13),
              ),
            ),
          Expanded(
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(vertical: 4),
              itemCount: _suggestions.length,
              separatorBuilder: (_, _) => Divider(
                height: 1,
                color: Colors.grey.shade200,
                indent: 20,
                endIndent: 20,
              ),
              itemBuilder: (context, index) {
                final s = _suggestions[index];
                return ListTile(
                  leading: Icon(
                    Icons.place_outlined,
                    color: Colors.grey.shade600,
                  ),
                  title: Text(
                    s.description,
                    style: const TextStyle(fontSize: 14.5),
                  ),
                  onTap: () => _selectSuggestion(s),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
