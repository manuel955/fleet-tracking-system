import 'dart:async';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart'
    show MapboxOptions;
import 'config.dart';
import 'screens/account_tab_screen.dart';
import 'screens/active_trip_tracking_screen.dart';
import 'screens/activity_tab_screen.dart';
import 'screens/home_tab_screen.dart';
import 'screens/passenger_access_screen.dart';
import 'screens/registration_screen.dart';
import 'screens/searching_screen.dart';
import 'services/notification_service.dart';
import 'services/auth_service.dart';
import 'services/passenger_service.dart';
import 'services/push_service.dart';
import 'services/trip_service.dart';
import 'services/update_service.dart';
import 'theme/app_theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AuthService.initialize();

  if (!kIsWeb && AppConfig.mapboxAccessToken.isNotEmpty) {
    MapboxOptions.setAccessToken(AppConfig.mapboxAccessToken);
  }

  // En web solo necesitamos revisar la interfaz local. Estas integraciones
  // dependen de Firebase/Android y no deben bloquear el arranque del preview.
  if (!kIsWeb) {
    await NotificationService.initialize();
    await PushService.initialize();
  }
  runApp(const FleetPassengerApp());
}

class FleetPassengerApp extends StatelessWidget {
  const FleetPassengerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'APL Pasajeros',
      theme: buildAppTheme(),
      home: const _UpdateGate(
        appName: 'la app de pasajeros',
        child: PassengerHomePage(),
      ),
    );
  }
}

class _UpdateGate extends StatefulWidget {
  const _UpdateGate({required this.appName, required this.child});

  final String appName;
  final Widget child;

  @override
  State<_UpdateGate> createState() => _UpdateGateState();
}

class _UpdateGateState extends State<_UpdateGate> {
  bool _checking = true;
  bool _updateRequired = false;
  bool _openingDownload = false;

  @override
  void initState() {
    super.initState();
    _checkForUpdate();
  }

  Future<void> _checkForUpdate() async {
    if (kIsWeb) {
      if (mounted) {
        setState(() {
          _checking = false;
          _updateRequired = false;
        });
      }
      return;
    }

    final updateRequired = await UpdateService.isUpdateRequired();
    if (mounted) {
      setState(() {
        _checking = false;
        _updateRequired = updateRequired;
      });
    }
  }

  Future<void> _downloadUpdate() async {
    setState(() => _openingDownload = true);
    await UpdateService.downloadUpdate();
    if (mounted) setState(() => _openingDownload = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_checking) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (!_updateRequired) return widget.child;

    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.system_update, size: 56),
              const SizedBox(height: 20),
              Text(
                'Actualización obligatoria',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 12),
              Text(
                'Hay una nueva versión de ${widget.appName}. Descárgala e instálala para continuar.',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: _openingDownload ? null : _downloadUpdate,
                child: Text(
                  _openingDownload ? 'Abriendo descarga…' : 'Actualizar ahora',
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class PassengerHomePage extends StatefulWidget {
  const PassengerHomePage({super.key});

  @override
  State<PassengerHomePage> createState() => _PassengerHomePageState();
}

class _PassengerHomePageState extends State<PassengerHomePage> {
  bool _loading = true;
  bool _registered = false;
  bool _accessGranted = false;
  String? _activeTripId;
  Map<String, dynamic>? _activeTrip;
  // Viaje programado, aparte del "activo": no bloquea las pestañas -- el
  // pasajero puede seguir usando la app (y pedir un viaje para ahora) con
  // un viaje programado en espera. Se muestra como tarjeta en Inicio.
  String? _scheduledTripId;
  Map<String, dynamic>? _scheduledTrip;
  Timer? _scheduledPollTimer;
  Timer? _accessValidationTimer;
  StreamSubscription<RemoteMessage>? _foregroundMessageSubscription;
  StreamSubscription<String>? _notificationOpenSubscription;
  bool _bootstrapInFlight = false;
  bool _scheduledPollInFlight = false;
  bool _accessValidationInFlight = false;
  int _tabIndex = 0;
  final _activityKey = GlobalKey<ActivityTabScreenState>();

  @override
  void initState() {
    super.initState();
    _bootstrap();
    if (!kIsWeb) {
      _notificationOpenSubscription = NotificationService.openedPayloads.listen(
        _onNotificationOpened,
      );
      final pendingPayload = NotificationService.takePendingOpenedPayload();
      if (pendingPayload != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _onNotificationOpened(pendingPayload);
        });
      }
    }
    _scheduledPollTimer = Timer.periodic(
      const Duration(seconds: 15),
      (_) => _pollScheduledTrip(),
    );
    _accessValidationTimer = Timer.periodic(
      const Duration(minutes: 1),
      (_) => _validatePassengerAccess(),
    );
  }

  @override
  void dispose() {
    _scheduledPollTimer?.cancel();
    _accessValidationTimer?.cancel();
    _foregroundMessageSubscription?.cancel();
    _notificationOpenSubscription?.cancel();
    super.dispose();
  }

  void _onNotificationOpened(String _) {
    if (!mounted) return;
    unawaited(_bootstrap());
  }

  Future<void> _validatePassengerAccess() async {
    if (!_registered || _accessValidationInFlight) return;
    _accessValidationInFlight = true;
    bool accessGranted;
    try {
      accessGranted = await PassengerService.ensureAccess();
    } catch (_) {
      // Una caida de red no revoca el acceso que aun es valido en la cache.
      accessGranted = await PassengerService.hasAccess();
    } finally {
      _accessValidationInFlight = false;
    }
    if (!mounted) return;
    final hasOpenService = _activeTripId != null || _scheduledTripId != null;
    if (accessGranted != _accessGranted && (accessGranted || !hasOpenService)) {
      setState(() => _accessGranted = accessGranted);
    }
  }

  bool _scheduledTripViewChanged(Map<String, dynamic> next) {
    final current = _scheduledTrip;
    if (current == null) return true;
    const keys = [
      'status',
      'scheduledPickupLabel',
      'scheduledPickupAt',
      'pickupAddress',
      'destinationAddress',
    ];
    return keys.any((key) => current[key] != next[key]);
  }

  // Revisa si el viaje programado ya fue despachado (Cloud Functions lo
  // asigna cerca de la hora elegida) o cancelado/completado desde otro
  // lado (ej. el dashboard). Corre en segundo plano aunque el pasajero
  // este en cualquier pestaña, no solo si esta viendo la tarjeta.
  Future<void> _pollScheduledTrip() async {
    final id = _scheduledTripId;
    if (id == null || _scheduledPollInFlight) return;
    _scheduledPollInFlight = true;
    Map<String, dynamic>? trip;
    try {
      trip = await TripService.getTrip(id);
    } catch (_) {
      return;
    } finally {
      _scheduledPollInFlight = false;
    }
    if (!mounted) return;
    if (trip == null ||
        trip['status'] == 'completed' ||
        trip['status'] == 'cancelled') {
      await TripService.clearScheduledTrip();
      if (mounted) {
        setState(() {
          _scheduledTripId = null;
          _scheduledTrip = null;
        });
      }
      return;
    }
    if (trip['status'] != 'scheduled') {
      // Ya se despacho: si no hay otro viaje activo bloqueando la pantalla,
      // pasa a serlo. Si ya hay uno, se reintenta en el siguiente tick.
      if (_activeTripId == null) {
        await TripService.promoteScheduledTrip(id);
        if (mounted) {
          setState(() {
            _activeTripId = id;
            _activeTrip = trip;
            _scheduledTripId = null;
            _scheduledTrip = null;
          });
        }
      }
      return;
    }
    if (mounted && _scheduledTripViewChanged(trip)) {
      setState(() => _scheduledTrip = trip);
    }
  }

  Future<void> _bootstrap() async {
    if (_bootstrapInFlight) return;
    _bootstrapInFlight = true;
    try {
      final registered = await PassengerService.isRegistered();
      // Un pasajero que ya tenía registro antes de activar los QR conserva la
      // entrada aunque el primer intento de sincronización esté sin red.
      var accessGranted = await PassengerService.hasAccess();
      if (registered) {
        // Conserva el acceso de cuentas antiguas. El servidor solo migra
        // perfiles creados antes de activar el control QR.
        try {
          // Una respuesta del servidor tiene prioridad sobre la caché local:
          // si el administrador revocó el QR, no se conserva un acceso antiguo.
          accessGranted = await PassengerService.ensureAccess();
        } catch (_) {
          // Si no hay red, no se rompe la pantalla ya registrada; el siguiente
          // intento volverá a sincronizar la autorización.
        }
      }

      // Con la app visible, el push llega por aqui en vez de por el handler
      // de background -- mismo patron que driver-app/lib/main.dart.
      if (!kIsWeb && _foregroundMessageSubscription == null) {
        _foregroundMessageSubscription = FirebaseMessaging.onMessage.listen((
          message,
        ) {
          switch (message.data['type']) {
            case 'driver_arrived':
              NotificationService.showDriverArrived(
                message.data['tripId']?.toString(),
              );
              break;
            case 'trip_updated':
              NotificationService.showSimple(
                'Viaje actualizado',
                'El destino de tu viaje cambió.',
              );
              break;
            case 'trip_cancelled':
              NotificationService.showTripCancelled(
                message.data['reason']?.toString(),
              );
              break;
            case 'trip_status':
              if (message.data['status']?.toString() == 'completed') {
                NotificationService.showSimple(
                  'Viaje finalizado',
                  'Abre la app para calificarlo.',
                );
              }
              break;
            case 'trip_completed':
              NotificationService.showSimple(
                'Viaje finalizado',
                'Tu viaje terminó. Abre la app para calificarlo.',
              );
              break;
            case 'no_drivers_available':
              NotificationService.showSimple(
                'Sin conductores disponibles',
                message.data['reason']?.toString() ??
                    'No encontramos un conductor disponible. Abre la app para reintentar.',
              );
              _pollScheduledTrip();
              break;
          }
        });
      }
      if (registered) unawaited(PushService.registerToken());

      var activeTripId = await TripService.getActiveTripId();

      Map<String, dynamic>? trip;
      Map<String, dynamic>? completedTripToRate;
      String? completedTripId;
      if (activeTripId != null) {
        try {
          trip = await TripService.getTrip(activeTripId);
          if (trip?['status'] == 'completed') {
            completedTripToRate = trip;
            completedTripId = activeTripId;
            await TripService.clearActiveTrip();
            trip = null;
            activeTripId = null;
          } else if (trip == null || trip['status'] == 'cancelled') {
            await TripService.clearActiveTrip();
            trip = null;
            activeTripId = null;
          }
        } catch (_) {
          trip = await TripService.getCachedTrip(activeTripId!);
        }
      }

      var scheduledTripId = await TripService.getScheduledTripId();
      Map<String, dynamic>? scheduledTrip;
      if (scheduledTripId != null) {
        try {
          scheduledTrip = await TripService.getTrip(scheduledTripId);
          if (scheduledTrip == null ||
              scheduledTrip['status'] == 'completed' ||
              scheduledTrip['status'] == 'cancelled') {
            await TripService.clearScheduledTrip();
            scheduledTrip = null;
            scheduledTripId = null;
          } else if (scheduledTrip['status'] != 'scheduled') {
            // Ya se habia despachado (dejo de estar 'scheduled') mientras la
            // app estaba cerrada -- se trata directo como viaje activo, si no
            // hay ya otro viaje inmediato ocupando ese lugar.
            await TripService.promoteScheduledTrip(scheduledTripId);
            if (trip == null) {
              trip = scheduledTrip;
              activeTripId = scheduledTripId;
            }
            scheduledTrip = null;
          }
        } catch (_) {
          scheduledTrip = await TripService.getCachedTrip(scheduledTripId!);
        }
      }

      // SharedPreferences es solo una caché. Si la app se cerró después de que
      // el servidor creó el viaje pero antes de guardar el ID local, recupera
      // los viajes abiertos desde Firebase y reconstruye ambos estados.
      if (trip == null || scheduledTrip == null) {
        try {
          final recovered = await TripService.recoverOpenTrips();
          if (trip == null && recovered.active != null) {
            activeTripId = recovered.active!.key;
            trip = recovered.active!.value;
          }
          if (scheduledTrip == null && recovered.scheduled != null) {
            scheduledTripId = recovered.scheduled!.key;
            scheduledTrip = recovered.scheduled!.value;
          }
        } catch (_) {
          // Sin red se conservan los IDs locales para reintentar al reiniciar.
        }
      }

      // Si el viaje terminó mientras la app estaba minimizada/cerrada, ya no
      // existe un active_trip_id que recuperar. Busca el último completado sin
      // feedback para abrir la calificación automáticamente al volver.
      if (completedTripToRate == null && trip == null) {
        try {
          final pendingFeedback = await TripService.recoverPendingFeedback();
          if (pendingFeedback != null) {
            completedTripId = pendingFeedback.key;
            completedTripToRate = pendingFeedback.value;
          }
        } catch (_) {
          // El historial se reintentará al abrir Actividad; no bloquea el inicio.
        }
      }

      accessGranted =
          accessGranted || activeTripId != null || scheduledTripId != null;

      if (!mounted) return;
      setState(() {
        _registered = registered;
        _accessGranted = accessGranted;
        _activeTripId = activeTripId;
        _activeTrip = trip;
        _scheduledTripId = scheduledTripId;
        _scheduledTrip = scheduledTrip;
        _loading = false;
      });
      if (completedTripToRate != null && completedTripId != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) async {
          if (!mounted) return;
          await _activityKey.currentState?.openFeedbackForTrip(
            completedTripId!,
            completedTripToRate!,
          );
        });
      }
    } finally {
      _bootstrapInFlight = false;
    }
  }

  void _onRegistered() {
    PushService.registerToken();
    if (mounted) setState(() => _registered = true);
  }

  void _onAccessAuthorized(Map<String, dynamic> _) {
    if (mounted) setState(() => _accessGranted = true);
  }

  Future<void> _onEmailAuthenticated(Map<String, dynamic> _) async {
    final accessGranted = await PassengerService.ensureAccess();
    final profile = await PassengerService.loadProfile();
    if (!mounted) return;
    setState(() {
      _accessGranted = accessGranted;
      _registered = profile != null;
      _tabIndex = 0;
    });
    PushService.registerToken();
  }

  void _onLoggedOut() {
    if (!mounted) return;
    setState(() {
      _registered = false;
      _accessGranted = false;
      _tabIndex = 0;
      _activeTripId = null;
      _activeTrip = null;
      _scheduledTripId = null;
      _scheduledTrip = null;
    });
  }

  // Un mismo flujo de pedido (RequestRideScreen) puede terminar en un
  // viaje inmediato ('searching') o uno programado ('scheduled') -- se
  // guarda en el estado correspondiente segun lo que haya devuelto el
  // servidor, sin bloquear las pestañas si fue programado.
  void _onRideRequested(String tripId) async {
    final trip = await TripService.getTrip(tripId);
    if (!mounted) return;
    if (trip != null && trip['status'] == 'scheduled') {
      setState(() {
        _scheduledTripId = tripId;
        _scheduledTrip = trip;
      });
      return;
    }
    setState(() {
      _activeTripId = tripId;
      _activeTrip = trip;
    });
  }

  // SearchingScreen llama esto para CUALQUIER cambio de estado del viaje
  // activo, incluido que lo cancelen desde el dashboard mientras el
  // pasajero sigue en "buscando conductor" -- sin este chequeo el viaje se
  // quedaba mostrando "buscando..." con un boton "Cancelar viaje" que ya
  // no podia hacer nada (las reglas de RTDB rechazan re-cancelar un viaje
  // que ya quedo 'cancelled', asi que el pasajero veia el boton fallar).
  void _onTripStatusChanged(Map<String, dynamic> trip) {
    final status = trip['status'] as String?;
    if (status == 'completed' || status == 'cancelled') {
      _onTripFinished(finishedTrip: trip, showActivity: true);
      return;
    }
    setState(() => _activeTrip = trip);
  }

  void _onTripFinished({
    Map<String, dynamic>? finishedTrip,
    bool showActivity = false,
  }) {
    final tripId = _activeTripId;
    final trip = finishedTrip ?? _activeTrip;
    final completed = trip?['status'] == 'completed';
    TripService.clearActiveTrip();
    setState(() {
      _activeTripId = null;
      _activeTrip = null;
    });
    unawaited(_validatePassengerAccess());
    if (completed && tripId != null && trip != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (!mounted) return;
        await _activityKey.currentState?.openFeedbackForTrip(tripId, trip);
      });
    } else if (showActivity) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('El viaje fue cancelado.')),
        );
      });
    }
  }

  void _onScheduledTripCancelled() {
    setState(() {
      _scheduledTripId = null;
      _scheduledTrip = null;
    });
    unawaited(_validatePassengerAccess());
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    if (_activeTripId != null && _activeTrip != null) {
      final status = _activeTrip!['status'] as String?;
      if (status == 'accepted' ||
          status == 'arrived_at_pickup' ||
          status == 'in_progress') {
        return ActiveTripTrackingScreen(
          tripId: _activeTripId!,
          trip: _activeTrip!,
          onFinished: (finishedTrip) =>
              _onTripFinished(finishedTrip: finishedTrip, showActivity: true),
        );
      }
      return SearchingScreen(
        tripId: _activeTripId!,
        trip: _activeTrip!,
        onStatusChanged: _onTripStatusChanged,
        onCancelled: _onTripFinished,
      );
    }

    if (_activeTripId != null && _activeTrip == null) {
      return _buildOfflineRecoveryScreen('viaje en curso');
    }

    if (_scheduledTripId != null && _scheduledTrip == null) {
      return _buildOfflineRecoveryScreen('viaje programado');
    }

    if (!_accessGranted) {
      return PassengerAccessScreen(
        onAuthorized: _onAccessAuthorized,
        onEmailAuthenticated: _onEmailAuthenticated,
      );
    }

    if (!_registered) {
      return RegistrationScreen(
        onDone: _onRegistered,
        onEmailAuthenticated: _onEmailAuthenticated,
      );
    }

    final tabs = [
      HomeTabScreen(
        onRequested: _onRideRequested,
        scheduledTripId: _scheduledTripId,
        scheduledTrip: _scheduledTrip,
        onScheduledTripCancelled: _onScheduledTripCancelled,
      ),
      ActivityTabScreen(key: _activityKey),
      AccountTabScreen(
        onLoggedOut: _onLoggedOut,
        onEmailAuthenticated: _onEmailAuthenticated,
      ),
    ];

    return Scaffold(
      body: IndexedStack(index: _tabIndex, children: tabs),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tabIndex,
        onDestinationSelected: (index) => setState(() => _tabIndex = index),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.home_outlined),
            selectedIcon: Icon(Icons.home),
            label: 'Inicio',
          ),
          NavigationDestination(
            icon: Icon(Icons.receipt_long_outlined),
            selectedIcon: Icon(Icons.receipt_long),
            label: 'Actividad',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: 'Cuenta',
          ),
        ],
      ),
    );
  }

  Widget _buildOfflineRecoveryScreen(String serviceLabel) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.cloud_off_outlined, size: 56),
                const SizedBox(height: 18),
                const Text(
                  'No pudimos conectar',
                  style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 10),
                Text(
                  'Tu $serviceLabel sigue guardado. Revisa tu conexion y vuelve a intentar; no crearemos otro viaje.',
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 24),
                FilledButton.icon(
                  onPressed: _bootstrap,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Reintentar conexion'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
