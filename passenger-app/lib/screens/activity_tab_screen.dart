import 'package:flutter/material.dart';
import '../services/trip_service.dart';
import '../theme/app_theme.dart';

/// Pestaña "Actividad": historial de viajes del pasajero, mas recientes
/// primero.
class ActivityTabScreen extends StatefulWidget {
  const ActivityTabScreen({super.key});

  @override
  State<ActivityTabScreen> createState() => _ActivityTabScreenState();
}

class _ActivityTabScreenState extends State<ActivityTabScreen> {
  late Future<List<MapEntry<String, Map<String, dynamic>>>> _tripsFuture;

  @override
  void initState() {
    super.initState();
    _tripsFuture = TripService.getMyTrips();
  }

  Future<void> _refresh() async {
    setState(() => _tripsFuture = TripService.getMyTrips());
    await _tripsFuture;
  }

  String _statusLabel(String? status) {
    switch (status) {
      case 'completed':
        return 'Completado';
      case 'cancelled':
        return 'Cancelado';
      case 'no_drivers_available':
        return 'Sin conductores';
      case 'scheduled':
        return 'Programado';
      default:
        return status ?? '-';
    }
  }

  Color _statusColor(String? status) {
    switch (status) {
      case 'completed':
        return AppColors.green;
      case 'cancelled':
        return AppColors.red;
      default:
        return AppColors.muted;
    }
  }

  String _formatDate(int? millis) {
    if (millis == null) return '-';
    final date = DateTime.fromMillisecondsSinceEpoch(millis);
    return '${date.day.toString().padLeft(2, '0')}/${date.month.toString().padLeft(2, '0')}/${date.year} '
        '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(20, 24, 20, 12),
            child: Text('Actividad', style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold)),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _refresh,
              child: FutureBuilder<List<MapEntry<String, Map<String, dynamic>>>>(
                future: _tripsFuture,
                builder: (context, snapshot) {
                  if (snapshot.connectionState != ConnectionState.done) {
                    return const Center(child: CircularProgressIndicator(color: AppColors.ink));
                  }
                  if (snapshot.hasError) {
                    return ListView(
                      children: [
                        Padding(
                          padding: const EdgeInsets.all(20),
                          child: Text('Error al cargar: ${snapshot.error}'),
                        ),
                      ],
                    );
                  }
                  final trips = snapshot.data ?? [];
                  if (trips.isEmpty) {
                    return ListView(
                      children: const [
                        Padding(
                          padding: EdgeInsets.all(32),
                          child: Center(
                            child: Text(
                              'Aún no tienes viajes.',
                              style: TextStyle(color: AppColors.muted, fontSize: 15),
                            ),
                          ),
                        ),
                      ],
                    );
                  }
                  return ListView.separated(
                    padding: const EdgeInsets.symmetric(horizontal: 20),
                    itemCount: trips.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final trip = trips[index].value;
                      final pickup = trip['pickupAddress'] as String? ?? 'Punto de partida';
                      final destination = trip['destinationAddress'] as String?;
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Container(
                              padding: const EdgeInsets.all(10),
                              decoration: const BoxDecoration(color: AppColors.paperMuted, shape: BoxShape.circle),
                              child: const Icon(Icons.local_taxi, color: AppColors.ink),
                            ),
                            const SizedBox(width: 14),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Expanded(
                                        child: Text(
                                          _formatDate(trip['requestedAt'] as int?),
                                          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                                        ),
                                      ),
                                      Text(
                                        _statusLabel(trip['status'] as String?),
                                        style: TextStyle(
                                          fontSize: 13,
                                          color: _statusColor(trip['status'] as String?),
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    trip['driverName'] as String? ?? 'Sin conductor asignado',
                                    style: const TextStyle(fontSize: 13, color: AppColors.muted),
                                  ),
                                  const SizedBox(height: 10),
                                  _RoutePoint(icon: Icons.circle, iconSize: 8, label: pickup),
                                  const Padding(
                                    padding: EdgeInsets.only(left: 3.5),
                                    child: SizedBox(height: 14, child: VerticalDivider(width: 1, thickness: 1)),
                                  ),
                                  _RoutePoint(
                                    icon: Icons.square,
                                    iconSize: 8,
                                    label: destination ?? 'Sin destino definido',
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      );
                    },
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Fila "punto de partida" / "destino" del historial (icono + direccion),
/// mismo lenguaje visual (circulo/cuadrado) que el buscador de destino.
class _RoutePoint extends StatelessWidget {
  final IconData icon;
  final double iconSize;
  final String label;

  const _RoutePoint({required this.icon, required this.iconSize, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Icon(icon, size: iconSize, color: AppColors.ink),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 13, color: AppColors.ink),
          ),
        ),
      ],
    );
  }
}
