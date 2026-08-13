import 'package:flutter/material.dart';
import '../services/trip_service.dart';
import '../theme/app_theme.dart';

/// Pestaña "Actividad": historial de viajes del pasajero, mas recientes
/// primero.
class ActivityTabScreen extends StatefulWidget {
  const ActivityTabScreen({super.key});

  @override
  ActivityTabScreenState createState() => ActivityTabScreenState();
}

class ActivityTabScreenState extends State<ActivityTabScreen> {
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

  Future<void> _openFeedback(String tripId, Map<String, dynamic> trip) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _TripFeedbackSheet(tripId: tripId, trip: trip),
    );
    if (saved == true && mounted) await _refresh();
  }

  Map<String, dynamic>? _feedbackForTrip(Map<String, dynamic> trip) {
    if (trip['feedback'] is Map) {
      return Map<String, dynamic>.from(trip['feedback'] as Map);
    }
    // El API VPS expone rating/comment directamente en el viaje. Normaliza
    // esa forma para que el historial no vuelva a pedir una calificación ya
    // guardada.
    final rating = trip['rating'];
    final comment = trip['feedbackComment']?.toString() ?? '';
    if (rating != null || comment.trim().isNotEmpty) {
      return {'rating': rating, 'comment': comment};
    }
    return null;
  }

  /// Abre el formulario de calificación desde el flujo de finalización del
  /// viaje. Si el pasajero cierra el formulario, permanece en Actividad y
  /// puede volver a abrirlo desde el historial.
  Future<void> openFeedbackForTrip(
    String tripId,
    Map<String, dynamic> trip,
  ) async {
    if (!mounted) return;
    await _openFeedback(tripId, trip);
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
            child: Text(
              'Actividad',
              style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _refresh,
              child: FutureBuilder<List<MapEntry<String, Map<String, dynamic>>>>(
                future: _tripsFuture,
                builder: (context, snapshot) {
                  if (snapshot.connectionState != ConnectionState.done) {
                    return const Center(
                      child: CircularProgressIndicator(color: AppColors.ink),
                    );
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
                              style: TextStyle(
                                color: AppColors.muted,
                                fontSize: 15,
                              ),
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
                      final tripId = trips[index].key;
                      final trip = trips[index].value;
                      final status = trip['status']?.toString();
                      final canComment =
                          status == 'completed' || status == 'cancelled';
                      final feedback = _feedbackForTrip(trip);
                      final pickup =
                          trip['pickupAddress'] as String? ??
                          'Punto de partida';
                      final destination = trip['destinationAddress'] as String?;
                      return InkWell(
                        onTap: canComment
                            ? () => _openFeedback(tripId, trip)
                            : null,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Container(
                                padding: const EdgeInsets.all(10),
                                decoration: const BoxDecoration(
                                  color: AppColors.paperMuted,
                                  shape: BoxShape.circle,
                                ),
                                child: const Icon(
                                  Icons.local_taxi,
                                  color: AppColors.ink,
                                ),
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
                                            _formatDate(
                                              trip['requestedAt'] as int?,
                                            ),
                                            style: const TextStyle(
                                              fontSize: 15,
                                              fontWeight: FontWeight.w600,
                                            ),
                                          ),
                                        ),
                                        Text(
                                          _statusLabel(
                                            trip['status'] as String?,
                                          ),
                                          style: TextStyle(
                                            fontSize: 13,
                                            color: _statusColor(
                                              trip['status'] as String?,
                                            ),
                                            fontWeight: FontWeight.w600,
                                          ),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      trip['driverName'] as String? ??
                                          'Sin conductor asignado',
                                      style: const TextStyle(
                                        fontSize: 13,
                                        color: AppColors.muted,
                                      ),
                                    ),
                                    const SizedBox(height: 10),
                                    _RoutePoint(
                                      icon: Icons.circle,
                                      iconSize: 8,
                                      label: pickup,
                                    ),
                                    const Padding(
                                      padding: EdgeInsets.only(left: 3.5),
                                      child: SizedBox(
                                        height: 14,
                                        child: VerticalDivider(
                                          width: 1,
                                          thickness: 1,
                                        ),
                                      ),
                                    ),
                                    _RoutePoint(
                                      icon: Icons.square,
                                      iconSize: 8,
                                      label:
                                          destination ?? 'Sin destino definido',
                                    ),
                                    if (canComment) ...[
                                      const SizedBox(height: 12),
                                      Row(
                                        children: [
                                          Icon(
                                            feedback == null
                                                ? Icons.rate_review_outlined
                                                : Icons.check_circle_outline,
                                            size: 16,
                                            color: feedback == null
                                                ? AppColors.muted
                                                : AppColors.green,
                                          ),
                                          const SizedBox(width: 6),
                                          Expanded(
                                            child: Text(
                                              feedback == null
                                                  ? 'Calificar o reportar una incidencia'
                                                  : _feedbackLabel(feedback),
                                              style: TextStyle(
                                                fontSize: 12.5,
                                                fontWeight: FontWeight.w600,
                                                color: feedback == null
                                                    ? AppColors.muted
                                                    : AppColors.green,
                                              ),
                                            ),
                                          ),
                                          const Icon(
                                            Icons.chevron_right,
                                            size: 18,
                                            color: AppColors.muted,
                                          ),
                                        ],
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            ],
                          ),
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

  String _feedbackLabel(Map<String, dynamic> feedback) {
    final rating = (feedback['rating'] as num?)?.toInt();
    final hasIncident =
        feedback['incidentCategory'] != null &&
        feedback['incidentCategory'] != 'none';
    if (rating != null && hasIncident) return '$rating/5 · Incidencia enviada';
    if (rating != null) return 'Calificación guardada: $rating/5';
    return 'Incidencia enviada';
  }
}

class _TripFeedbackSheet extends StatefulWidget {
  final String tripId;
  final Map<String, dynamic> trip;

  const _TripFeedbackSheet({required this.tripId, required this.trip});

  @override
  State<_TripFeedbackSheet> createState() => _TripFeedbackSheetState();
}

class _TripFeedbackSheetState extends State<_TripFeedbackSheet> {
  static const _incidentLabels = <String, String>{
    'none': 'Sin incidencia',
    'driver_conduct': 'Conducta del conductor',
    'service_quality': 'Calidad del servicio',
    'safety': 'Seguridad',
    'lost_item': 'Objeto perdido',
    'other': 'Otro',
  };

  late final TextEditingController _commentController;
  late final TextEditingController _incidentController;
  late int _rating;
  late String _incidentCategory;
  bool _saving = false;
  String? _error;

  bool get _isCompleted => widget.trip['status'] == 'completed';

  @override
  void initState() {
    super.initState();
    final feedback = widget.trip['feedback'] is Map
        ? Map<String, dynamic>.from(widget.trip['feedback'] as Map)
        : {
            if (widget.trip['rating'] != null) 'rating': widget.trip['rating'],
            if (widget.trip['feedbackComment'] != null)
              'comment': widget.trip['feedbackComment'],
          };
    _rating = (feedback['rating'] as num?)?.toInt() ?? 0;
    _incidentCategory = feedback['incidentCategory']?.toString() ?? 'none';
    _commentController = TextEditingController(
      text: feedback['comment']?.toString() ?? '',
    );
    _incidentController = TextEditingController(
      text: feedback['incidentDetails']?.toString() ?? '',
    );
  }

  @override
  void dispose() {
    _commentController.dispose();
    _incidentController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await TripService.submitFeedback(
        tripId: widget.tripId,
        rating: _rating == 0 ? null : _rating,
        comment: _commentController.text,
        incidentCategory: _incidentCategory,
        incidentDetails: _incidentController.text,
      );
      if (!mounted) return;
      final messenger = ScaffoldMessenger.maybeOf(context);
      Navigator.pop(context, true);
      messenger?.showSnackBar(
        const SnackBar(
          content: Text('Gracias. Tu información quedó guardada.'),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = error.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        24,
        20,
        24,
        24 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              _isCompleted ? '¿Cómo estuvo tu viaje?' : 'Cuéntanos qué ocurrió',
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 6),
            const Text(
              'Tu respuesta ayuda al equipo de operaciones a mejorar el servicio.',
              style: TextStyle(color: AppColors.muted),
            ),
            if (_isCompleted) ...[
              const SizedBox(height: 18),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(5, (index) {
                  final value = index + 1;
                  return IconButton(
                    tooltip: '$value de 5',
                    onPressed: _saving
                        ? null
                        : () => setState(() => _rating = value),
                    iconSize: 36,
                    icon: Icon(
                      value <= _rating ? Icons.star : Icons.star_border,
                      color: value <= _rating
                          ? Colors.amber.shade700
                          : AppColors.muted,
                    ),
                  );
                }),
              ),
            ],
            const SizedBox(height: 12),
            TextField(
              controller: _commentController,
              maxLength: 500,
              maxLines: 3,
              decoration: const InputDecoration(
                labelText: 'Comentario (opcional)',
                alignLabelWithHint: true,
              ),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _incidentCategory,
              decoration: const InputDecoration(
                labelText: 'Reportar una incidencia',
              ),
              items: _incidentLabels.entries
                  .map(
                    (entry) => DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
                  )
                  .toList(),
              onChanged: _saving
                  ? null
                  : (value) =>
                        setState(() => _incidentCategory = value ?? 'none'),
            ),
            if (_incidentCategory != 'none') ...[
              const SizedBox(height: 12),
              TextField(
                controller: _incidentController,
                maxLength: 1000,
                maxLines: 4,
                decoration: const InputDecoration(
                  labelText: 'Describe lo ocurrido',
                  helperText:
                      'Incluye la información necesaria para poder ayudarte.',
                  alignLabelWithHint: true,
                ),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: const TextStyle(color: AppColors.red)),
            ],
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Guardar respuesta'),
            ),
          ],
        ),
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

  const _RoutePoint({
    required this.icon,
    required this.iconSize,
    required this.label,
  });

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
