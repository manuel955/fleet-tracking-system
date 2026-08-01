import 'dart:async';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:google_maps_flutter_android/google_maps_flutter_android.dart';
import 'package:google_maps_flutter_platform_interface/google_maps_flutter_platform_interface.dart';
import 'screens/account_tab_screen.dart';
import 'screens/active_trip_tracking_screen.dart';
import 'screens/activity_tab_screen.dart';
import 'screens/home_tab_screen.dart';
import 'screens/registration_screen.dart';
import 'screens/searching_screen.dart';
import 'services/notification_service.dart';
import 'services/passenger_service.dart';
import 'services/push_service.dart';
import 'services/trip_service.dart';
import 'services/update_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // La app crea varios GoogleMap distintos a lo largo de una sesion
  // (pedir viaje, seguimiento del viaje activo). El modo de renderizado por
  // defecto (virtual display) puede dejar el segundo/tercer mapa en blanco
  // en algunos dispositivos (visto en un Huawei P30 Pro); "hybrid
  // composition" es la alternativa oficialmente recomendada para esto.
  final mapsImplementation = GoogleMapsFlutterPlatform.instance;
  if (mapsImplementation is GoogleMapsFlutterAndroid) {
    mapsImplementation.useAndroidViewSurface = true;
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
      title: 'Fleet Passenger App',
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.black,
          primary: Colors.black,
          brightness: Brightness.light,
        ),
        scaffoldBackgroundColor: Colors.white,
        appBarTheme: const AppBarTheme(
          backgroundColor: Colors.white,
          foregroundColor: Colors.black,
          elevation: 0,
          surfaceTintColor: Colors.transparent,
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.black,
            foregroundColor: Colors.white,
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
          ),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            foregroundColor: Colors.black,
            side: const BorderSide(color: Colors.black26),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
          ),
        ),
        // Sin esto, ProgressIndicator usa el "track" rosado que genera
        // Material 3 a partir de un seedColor negro (mismo problema que
        // tenia NavigationBar mas abajo).
        progressIndicatorTheme: const ProgressIndicatorThemeData(
          color: Colors.black,
          linearTrackColor: Colors.black12,
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.grey.shade50,
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 16,
            vertical: 14,
          ),
          labelStyle: TextStyle(color: Colors.grey.shade600),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: Colors.grey.shade300),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: Colors.grey.shade300),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Colors.black, width: 1.6),
          ),
          errorBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: Colors.red.shade400, width: 1.3),
          ),
          focusedErrorBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: Colors.red.shade600, width: 1.6),
          ),
        ),
        navigationBarTheme: NavigationBarThemeData(
          backgroundColor: Colors.white,
          surfaceTintColor: Colors.transparent,
          indicatorColor: Colors.grey.shade200,
          labelTextStyle: WidgetStateProperty.resolveWith((states) {
            final selected = states.contains(WidgetState.selected);
            return TextStyle(
              fontSize: 12,
              fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
              color: Colors.black,
            );
          }),
          iconTheme: WidgetStateProperty.resolveWith((states) {
            final selected = states.contains(WidgetState.selected);
            return IconThemeData(
              color: selected ? Colors.black : Colors.grey.shade600,
            );
          }),
        ),
      ),
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
  String? _activeTripId;
  Map<String, dynamic>? _activeTrip;
  // Viaje programado, aparte del "activo": no bloquea las pestañas -- el
  // pasajero puede seguir usando la app (y pedir un viaje para ahora) con
  // un viaje programado en espera. Se muestra como tarjeta en Inicio.
  String? _scheduledTripId;
  Map<String, dynamic>? _scheduledTrip;
  Timer? _scheduledPollTimer;
  int _tabIndex = 0;

  @override
  void initState() {
    super.initState();
    _bootstrap();
    _scheduledPollTimer = Timer.periodic(
      const Duration(seconds: 15),
      (_) => _pollScheduledTrip(),
    );
  }

  @override
  void dispose() {
    _scheduledPollTimer?.cancel();
    super.dispose();
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
    if (id == null) return;
    Map<String, dynamic>? trip;
    try {
      trip = await TripService.getTrip(id);
    } catch (_) {
      return;
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
    final registered = await PassengerService.isRegistered();

    // Con la app visible, el push llega por aqui en vez de por el handler
    // de background -- mismo patron que driver-app/lib/main.dart.
    FirebaseMessaging.onMessage.listen((message) {
      switch (message.data['type']) {
        case 'driver_arrived':
          NotificationService.showSimple(
            'Tu conductor llegó',
            'Te está esperando en el punto de recogida.',
          );
          break;
        case 'trip_updated':
          NotificationService.showSimple(
            'Viaje actualizado',
            'El destino de tu viaje cambió.',
          );
          break;
      }
    });
    if (registered) PushService.registerToken();

    var activeTripId = await TripService.getActiveTripId();

    Map<String, dynamic>? trip;
    if (activeTripId != null) {
      try {
        trip = await TripService.getTrip(activeTripId);
        if (trip == null ||
            trip['status'] == 'completed' ||
            trip['status'] == 'cancelled') {
          await TripService.clearActiveTrip();
          trip = null;
          activeTripId = null;
        }
      } catch (_) {
        trip = null;
        activeTripId = null;
      }
    }

    final scheduledTripId = await TripService.getScheduledTripId();
    Map<String, dynamic>? scheduledTrip;
    if (scheduledTripId != null) {
      try {
        scheduledTrip = await TripService.getTrip(scheduledTripId);
        if (scheduledTrip == null ||
            scheduledTrip['status'] == 'completed' ||
            scheduledTrip['status'] == 'cancelled') {
          await TripService.clearScheduledTrip();
          scheduledTrip = null;
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
        scheduledTrip = null;
      }
    }

    setState(() {
      _registered = registered;
      _activeTripId = trip != null ? activeTripId : null;
      _activeTrip = trip;
      _scheduledTripId = scheduledTrip != null ? scheduledTripId : null;
      _scheduledTrip = scheduledTrip;
      _loading = false;
    });
  }

  void _onRegistered() {
    PushService.registerToken();
    setState(() => _registered = true);
  }

  void _onLoggedOut() {
    setState(() {
      _registered = false;
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
      _onTripFinished();
      return;
    }
    setState(() => _activeTrip = trip);
  }

  void _onTripFinished() {
    TripService.clearActiveTrip();
    setState(() {
      _activeTripId = null;
      _activeTrip = null;
    });
  }

  void _onScheduledTripCancelled() {
    setState(() {
      _scheduledTripId = null;
      _scheduledTrip = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    if (!_registered) {
      return RegistrationScreen(onDone: _onRegistered);
    }

    if (_activeTripId != null && _activeTrip != null) {
      final status = _activeTrip!['status'] as String?;
      if (status == 'accepted' ||
          status == 'arrived_at_pickup' ||
          status == 'in_progress') {
        return ActiveTripTrackingScreen(
          tripId: _activeTripId!,
          trip: _activeTrip!,
          onFinished: _onTripFinished,
        );
      }
      return SearchingScreen(
        tripId: _activeTripId!,
        trip: _activeTrip!,
        onStatusChanged: _onTripStatusChanged,
        onCancelled: _onTripFinished,
      );
    }

    final tabs = [
      HomeTabScreen(
        onRequested: _onRideRequested,
        scheduledTripId: _scheduledTripId,
        scheduledTrip: _scheduledTrip,
        onScheduledTripCancelled: _onScheduledTripCancelled,
      ),
      const ActivityTabScreen(),
      AccountTabScreen(onLoggedOut: _onLoggedOut),
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
}
