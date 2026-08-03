import 'package:flutter/material.dart';
import '../services/preset_places_service.dart';
import 'destination_picker_screen.dart';

/// Lista + buscador de sedes deportivas u hoteles (segun [configKey]),
/// administrados desde el dashboard. Al tocar un lugar devuelve un
/// DestinationPickerResult, igual que DestinationPickerScreen, para que el
/// llamador lo lleve directo a RequestRideScreen (preview de viaje).
class PresetPlacesScreen extends StatefulWidget {
  final String title;
  final String configKey;

  const PresetPlacesScreen({super.key, required this.title, required this.configKey});

  @override
  State<PresetPlacesScreen> createState() => _PresetPlacesScreenState();
}

class _PresetPlacesScreenState extends State<PresetPlacesScreen> {
  final _searchCtrl = TextEditingController();
  bool _loading = true;
  String? _error;
  List<PresetPlace> _places = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final places = await PresetPlacesService.fetch(widget.configKey);
      if (mounted) setState(() { _places = places; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = 'No se pudo cargar la lista: $e'; _loading = false; });
    }
  }

  List<PresetPlace> get _filtered {
    final query = _searchCtrl.text.trim().toLowerCase();
    if (query.isEmpty) return _places;
    return _places.where((p) => p.name.toLowerCase().contains(query)).toList();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              controller: _searchCtrl,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: 'Buscar ${widget.title.toLowerCase()}',
              ),
            ),
          ),
          Expanded(child: _buildList()),
        ],
      ),
    );
  }

  Widget _buildList() {
    if (_loading) return const Center(child: CircularProgressIndicator(color: Colors.black));
    if (_error != null) return Center(child: Text(_error!, style: const TextStyle(color: Colors.red)));

    final filtered = _filtered;
    if (filtered.isEmpty) {
      return const Center(child: Text('No hay lugares para mostrar.'));
    }

    return ListView.separated(
      itemCount: filtered.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final place = filtered[index];
        return ListTile(
          leading: const Icon(Icons.place_outlined),
          title: Text(place.name, style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: Text(place.address),
          onTap: () => Navigator.pop(
            context,
            DestinationPickerResult(description: place.name, lat: place.lat, lng: place.lng),
          ),
        );
      },
    );
  }
}
