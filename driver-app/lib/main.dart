import 'dart:async';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:google_maps_flutter_android/google_maps_flutter_android.dart';
import 'package:google_maps_flutter_platform_interface/google_maps_flutter_platform_interface.dart';
import 'package:permission_handler/permission_handler.dart';
import 'config.dart';
import 'screens/active_trip_screen.dart';
import 'screens/driver_registration_screen.dart';
import 'screens/login_screen.dart';
import 'screens/pending_approval_screen.dart';
import 'services/auth_service.dart';
import 'services/driver_profile_service.dart';
import 'services/location_service.dart';
import 'services/notification_service.dart';
import 'services/push_service.dart';
import 'services/session_service.dart';
import 'services/trip_service.dart';
import 'widgets/support_button.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // La app crea varios GoogleMap distintos (pantalla principal, viaje
  // entrante, viaje activo). El modo de renderizado por defecto (virtual
  // display) puede dejar el segundo/tercer mapa en blanco en algunos
  // dispositivos (visto en un Huawei P30 Pro); "hybrid composition" es la
  // alternativa oficialmente recomendada para esto.
  final mapsImplementation = GoogleMapsFlutterPlatform.instance;
  if (mapsImplementation is GoogleMapsFlutterAndroid) {
    mapsImplementation.useAndroidViewSurface = true;
  }

  await LocationService.initialize();
  await NotificationService.initialize();
  await PushService.initialize();
  runApp(const FleetDriverApp());
}

class FleetDriverApp extends StatelessWidget {
  const FleetDriverApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Fleet Driver App',
      // Mismo tema blanco/negro estilo Uber que passenger-app (ver
      // passenger-app/lib/main.dart) para que ambas apps se sientan parte
      // del mismo producto.
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
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          ),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            foregroundColor: Colors.black,
            side: const BorderSide(color: Colors.black26),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          ),
        ),
        progressIndicatorTheme: const ProgressIndicatorThemeData(
          color: Colors.black,
          linearTrackColor: Colors.black12,
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.grey.shade50,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
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
      ),
      home: const DriverHomePage(),
    );
  }
}

class LogEntry {
  final String message;
  final DateTime time;
  LogEntry(this.message, this.time);
}

class DriverHomePage extends StatefulWidget {
  const DriverHomePage({super.key});

  @override
  State<DriverHomePage> createState() => _DriverHomePageState();
}

class _DriverHomePageState extends State<DriverHomePage> {
  GoogleMapController? _mapController;
  LatLng? _currentLatLng;

  bool _tracking = false;
  bool _loading = true;
  String? _driverId;
  PermissionStatus? _whenInUseStatus;
  PermissionStatus? _alwaysStatus;
  PermissionStatus? _notificationStatus;

  final List<LogEntry> _logs = [];

  // Sesion por correo/contraseña (persiste entre aperturas de la app, a
  // diferencia del DNI+rostro anterior que se re-pedia siempre).
  bool _loggedIn = false;
  bool _showRegister = false;
  Map<String, dynamic>? _driverProfile;

  bool _editingProfile = false;
  bool _savingProfile = false;

  final _profileFormKey = GlobalKey<FormState>();
  final _nameCtrl = TextEditingController();
  final _ageCtrl = TextEditingController();
  final _plateCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();

  // Estado de viajes: se consulta cada 5s si el conductor tiene un
  // currentTripId asignado automaticamente por Cloud Functions (sin pedirle
  // confirmacion), y se muestra la pantalla de "viaje activo" (He llegado
  // -> Pasajero a bordo -> Finalizar).
  Timer? _tripPollTimer;
  String? _tripId;
  Map<String, dynamic>? _tripData;

  // Poll independiente del de viajes (corre aprobado o no): detecta si otro
  // telefono inicio sesion con la misma cuenta y, si es asi, cierra esta
  // sesion solo (ver _checkSessionStillActive).
  Timer? _sessionCheckTimer;

  @override
  void initState() {
    super.initState();
    _bootstrap();

    FlutterBackgroundService().on('debug_log').listen((event) {
      if (event == null) return;
      _addLog(event['message'] as String);
    });

    FlutterBackgroundService().on('location_update').listen((event) {
      if (event == null) return;
      final lat = event['lat'] as double;
      final lng = event['lng'] as double;
      setState(() => _currentLatLng = LatLng(lat, lng));

      // Si una pantalla de viaje (entrante o activo) reemplazo la pantalla
      // principal, el GoogleMap de ahi ya fue destruido por Flutter aunque
      // este listener (registrado una sola vez en initState) siga vivo.
      // Sin este guard, animateCamera lanza "used after disposed".
      if (!_showingMainScreen) return;
      try {
        _mapController?.animateCamera(CameraUpdate.newLatLng(LatLng(lat, lng)));
      } catch (_) {
        // El controller quedo obsoleto justo en la transicion; se ignora,
        // el proximo update ya no entrara aqui gracias al guard de arriba.
      }
    });
  }

  // Misma condicion que build() usa para decidir si se muestra la
  // pantalla principal de rastreo (con su GoogleMap) en vez de las
  // pantallas de viaje entrante/activo.
  bool get _showingMainScreen {
    final tripStatus = _tripData?['status'] as String?;
    if (_tripId != null &&
        _tripData != null &&
        (tripStatus == 'accepted' || tripStatus == 'arrived_at_pickup' || tripStatus == 'in_progress')) {
      return false;
    }
    return true;
  }

  @override
  void dispose() {
    _tripPollTimer?.cancel();
    _sessionCheckTimer?.cancel();
    _nameCtrl.dispose();
    _ageCtrl.dispose();
    _plateCtrl.dispose();
    _phoneCtrl.dispose();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    // Cada apertura en frio de la app empieza limpia: si Android habia
    // reiniciado el servicio solo, se detiene aqui. El turno arranca de
    // nuevo automaticamente si la sesion sigue activa y el conductor ya
    // esta aprobado (ver _afterAuthResolved -> _startShift) y sigue
    // corriendo sin intervencion hasta que el mismo presione "Terminar
    // turno".
    if (await LocationService.isRunning()) {
      LocationService.stop();
    }

    await _refreshPermissionStatus();

    // Con la app visible, el push llega por aqui (no por el handler de
    // background): en vez de esperar el proximo tick de 5s, se consulta el
    // viaje de inmediato. El aviso sonoro lo pone _pollForTrip, que ya
    // deduplica por tripId.
    FirebaseMessaging.onMessage.listen((message) {
      if (message.data['type'] == 'trip_assigned') _pollForTrip();
    });

    final loggedIn = await AuthService.isLoggedIn();
    if (!loggedIn) {
      setState(() {
        _loggedIn = false;
        _loading = false;
      });
      return;
    }

    await _afterAuthResolved();
  }

  // Se llama despues de un login/registro/resubmision de documentos
  // exitosos (y una vez al arrancar, si ya habia sesion): trae el perfil
  // desde `drivers/{uid}` y decide que pantalla mostrar segun
  // `approvalStatus`. Si esta aprobado, arranca el turno automaticamente
  // (el conductor no tiene que presionar nada).
  //
  // `claimSession` solo debe ser true justo despues de que el conductor
  // escribio correo/contraseña (login o registro): genera un id de sesion
  // nuevo para este telefono y lo publica en `drivers/{uid}/activeSessionId`,
  // lo que "expulsa" a cualquier otro telefono que tuviera la cuenta
  // abierta. En un reinicio en frio con la sesion ya guardada NO se
  // reclama de nuevo (seria robarle la sesion a otro telefono que la haya
  // tomado despues), solo se seguira verificando que siga siendo la activa.
  Future<void> _afterAuthResolved({bool claimSession = false}) async {
    setState(() => _loading = true);
    try {
      final auth = await AuthService.currentSession();
      final uid = auth['uid'] as String;

      String? sessionId;
      if (claimSession) {
        sessionId = await SessionService.startNewSession();
        await DriverProfileService.claimSession(sessionId);
      } else {
        sessionId = await SessionService.localSessionId();
      }

      final profile = await DriverProfileService.fetchProfile(uid);

      if (profile == null) {
        // Cuenta creada pero sin nodo de perfil (ej. la app se cerro a
        // mitad del registro): no hay forma segura de continuar desde
        // aqui, se cierra la sesion para que el conductor vuelva a
        // registrarse desde cero.
        await AuthService.logout();
        setState(() {
          _loggedIn = false;
          _loading = false;
        });
        return;
      }

      // Reinicio en frio con una sesion que ya fue reemplazada por otro
      // telefono mientras esta app estaba cerrada: no se llega a mostrar
      // nada, se cierra de una vez en vez de esperar el primer tick del
      // poll periodico de abajo.
      if (!claimSession) {
        final remoteSessionId = profile['activeSessionId'] as String?;
        if (remoteSessionId != null && sessionId != null && remoteSessionId != sessionId) {
          await AuthService.logout();
          await SessionService.clear();
          setState(() {
            _loggedIn = false;
            _loading = false;
          });
          return;
        }
      }

      _nameCtrl.text = profile['name']?.toString() ?? '';
      _ageCtrl.text = profile['age']?.toString() ?? '';
      _plateCtrl.text = profile['plate']?.toString() ?? '';
      _phoneCtrl.text = profile['phone']?.toString() ?? '';

      setState(() {
        _driverId = uid;
        _driverProfile = profile;
        _loggedIn = true;
        _loading = false;
      });

      _sessionCheckTimer?.cancel();
      _sessionCheckTimer = Timer.periodic(const Duration(seconds: 20), (_) => _checkSessionStillActive());

      if (profile['approvalStatus'] == 'approved') {
        _tripPollTimer?.cancel();
        _tripPollTimer = Timer.periodic(const Duration(seconds: 5), (_) => _pollForTrip());
        _pollForTrip();
        PushService.registerToken();
        _startShift();
      }
    } catch (e) {
      setState(() {
        _loggedIn = false;
        _loading = false;
      });
    }
  }

  // Corre cada 20s mientras haya sesion (aprobado o no): si el
  // `activeSessionId` guardado en Firebase ya no coincide con el de este
  // telefono, es porque alguien inicio sesion con la misma cuenta en otro
  // dispositivo -- esta sesion se cierra sola, sin bloquear por viaje
  // activo (es una medida de seguridad de la cuenta, no una decision del
  // propio conductor).
  Future<void> _checkSessionStillActive() async {
    if (_driverId == null) return;
    try {
      final profile = await DriverProfileService.fetchProfile(_driverId!);
      final remoteSessionId = profile?['activeSessionId'] as String?;
      final localSessionId = await SessionService.localSessionId();
      if (remoteSessionId != null && localSessionId != null && remoteSessionId != localSessionId) {
        await _clearSessionAndReturnToLogin(
          message: 'Tu sesión se cerró porque iniciaste sesión en otro dispositivo.',
        );
      }
    } catch (_) {
      // Fallo de red puntual: se reintenta en el siguiente tick.
    }
  }

  Future<void> _pollForTrip() async {
    if (_driverId == null) return;
    try {
      final driverNode = await TripService.getMyDriverNode(_driverId!);
      final tripId = driverNode?['currentTripId'] as String?;

      if (tripId == null) {
        if (_tripId != null) setState(() { _tripId = null; _tripData = null; });
        return;
      }

      final trip = await TripService.getTrip(tripId);
      if (trip == null) {
        if (_tripId != null) setState(() { _tripId = null; _tripData = null; });
        return;
      }

      // Viaje nuevo (no uno que ya se estaba mostrando): avisa con sonido y
      // vibracion, ya que la asignacion es automatica y el conductor podria
      // no estar mirando la pantalla en ese momento. Solo si la app esta
      // visible: minimizada o cerrada, el aviso lo da el handler de FCM en
      // background (push_service.dart) y avisar aqui tambien duplicaria la
      // voz. El estado del viaje se actualiza igual, para que al volver a
      // la app ya este la pantalla del viaje activo.
      if (_tripId != tripId &&
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
        NotificationService.showTripAssigned();
      }

      setState(() {
        _tripId = tripId;
        _tripData = trip;
      });
    } catch (_) {
      // Fallo de red puntual: se reintenta en el siguiente tick del timer.
    }
  }

  Future<void> _saveProfile() async {
    if (!_profileFormKey.currentState!.validate()) return;

    setState(() => _savingProfile = true);

    // Si el usuario borro el "+51" o escribio solo digitos, se le agrega
    // el codigo de pais por defecto para que "Llamar" y WhatsApp funcionen.
    var phone = _phoneCtrl.text.trim();
    if (!phone.startsWith('+')) {
      phone = '${AppConfig.defaultPhoneCountryCode}$phone';
    }
    _phoneCtrl.text = phone;

    try {
      await DriverProfileService.updatePhone(phone);
      setState(() {
        _driverProfile = {...?_driverProfile, 'phone': phone};
        _editingProfile = false;
        _savingProfile = false;
      });
    } catch (e) {
      setState(() => _savingProfile = false);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error al guardar: $e')),
        );
      }
    }
  }

  Future<void> _refreshPermissionStatus() async {
    final whenInUse = await Permission.locationWhenInUse.status;
    final always = await Permission.locationAlways.status;
    final notification = await Permission.notification.status;
    setState(() {
      _whenInUseStatus = whenInUse;
      _alwaysStatus = always;
      _notificationStatus = notification;
    });
  }

  Future<bool> _requestPermissions() async {
    final whenInUse = await Permission.locationWhenInUse.request();
    if (!whenInUse.isGranted) {
      _addLog('Permiso de ubicación "mientras se usa" denegado.');
      await _refreshPermissionStatus();
      return false;
    }

    // Obligatorio: sin este permiso, iniciar el servicio en primer plano
    // (startForeground) puede matar la app entera en Android 13+ con
    // CannotPostForegroundServiceNotificationException.
    final notification = await Permission.notification.request();
    if (!notification.isGranted) {
      if (notification.isPermanentlyDenied) {
        _addLog('Permiso de notificaciones bloqueado permanentemente. Abre Ajustes de la app y actívalo a mano.');
        await openAppSettings();
      } else {
        _addLog('Permiso de notificaciones denegado. Es obligatorio: sin el, Android cierra la app al iniciar el rastreo.');
      }
      await _refreshPermissionStatus();
      return false;
    }

    final always = await Permission.locationAlways.request();
    await _refreshPermissionStatus();

    if (!always.isGranted) {
      _addLog('Permiso "todo el tiempo" no otorgado. El rastreo en segundo plano puede detenerse al minimizar la app.');
    }

    return true;
  }

  // Arranca el rastreo automaticamente (sin que el conductor tenga que
  // presionar nada) apenas la sesion queda resuelta y aprobada. Si algun
  // permiso falta, queda mostrado en la barra de estado y el conductor
  // puede reintentar con el boton "Reintentar inicio de turno".
  Future<void> _startShift() async {
    final granted = await _requestPermissions();
    if (!granted) return;

    await LocationService.start();
    setState(() => _tracking = true);
    _addLog('Turno iniciado: rastreo en curso.');
    if (_driverId != null) {
      try {
        // Si la app se cerro (crash, deslizar para quitarla de recientes,
        // reinicio del telefono) con un viaje asignado, currentTripId sigue
        // apuntando a el -- no hay que pisar 'busy' con 'online' aqui, o el
        // conductor queda "disponible" en el dashboard mientras el viaje
        // sigue en curso, y ni el dashboard ni el pasajero pueden saber que
        // sigue ocupado.
        final driverNode = await TripService.getMyDriverNode(_driverId!);
        if (driverNode?['currentTripId'] == null) {
          await TripService.setAvailability(_driverId!, online: true);
        }
      } catch (e) {
        _addLog('No se pudo actualizar disponibilidad: $e');
      }
    }
  }

  // Unica forma de detener el rastreo: el conductor termina su turno a
  // proposito. No hay boton para "pausar" -- una vez iniciado el turno,
  // el rastreo sigue hasta este punto. A diferencia de la version anterior,
  // terminar el turno YA NO cierra la sesion: la cuenta con correo y
  // contraseña persiste, solo hay que presionar "Reintentar inicio de
  // turno" para volver a trabajar.
  Future<void> _endShift() async {
    final activeStatus = _tripData?['status'] as String?;
    if (_tripId != null &&
        (activeStatus == 'accepted' || activeStatus == 'arrived_at_pickup' || activeStatus == 'in_progress')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No puedes terminar el turno con un viaje activo.')),
      );
      return;
    }

    LocationService.stop();
    _addLog('Turno terminado por el conductor.');
    if (_driverId != null) {
      try {
        await TripService.setAvailability(_driverId!, online: false);
      } catch (e) {
        _addLog('No se pudo actualizar disponibilidad: $e');
      }
    }

    setState(() => _tracking = false);
  }

  // Cierra la sesion por completo: corta el rastreo GPS (el servicio en
  // segundo plano y su notificacion fija desaparecen), cancela cualquier
  // notificacion de viaje pendiente y el poll de viajes, y borra la sesion
  // guardada -- la proxima vez hay que volver a iniciar sesion con correo y
  // contraseña. Igual que "Terminar turno", no se permite con un viaje
  // activo para no dejar al pasajero sin conductor a mitad de camino.
  Future<void> _logout() async {
    final activeStatus = _tripData?['status'] as String?;
    if (_tripId != null &&
        (activeStatus == 'accepted' || activeStatus == 'arrived_at_pickup' || activeStatus == 'in_progress')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No puedes cerrar sesión con un viaje activo.')),
      );
      return;
    }

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Cerrar sesión'),
        content: const Text(
          'Se detendrá el rastreo y las notificaciones, y no recibirás más viajes hasta que vuelvas a iniciar sesión.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Cerrar sesión')),
        ],
      ),
    );
    if (confirmed != true) return;

    if (_driverId != null) {
      try {
        await TripService.setAvailability(_driverId!, online: false);
      } catch (_) {
        // Sin red o ya desconectado: igual se sigue con el cierre de sesion.
      }
    }

    await _clearSessionAndReturnToLogin();
  }

  // Limpieza compartida por el cierre de sesion voluntario ("Cerrar
  // sesión") y el forzado (otro telefono tomo la cuenta): detiene el
  // rastreo GPS y sus timers, cancela notificaciones, borra la sesion
  // guardada localmente y vuelve a la pantalla de login. `message`, si se
  // da, se muestra en un snackbar para explicar por que se cerro sola.
  Future<void> _clearSessionAndReturnToLogin({String? message}) async {
    _tripPollTimer?.cancel();
    _tripPollTimer = null;
    _sessionCheckTimer?.cancel();
    _sessionCheckTimer = null;

    LocationService.stop();
    await NotificationService.cancelAll();
    await AuthService.logout();
    await SessionService.clear();

    if (!mounted) return;
    setState(() {
      _tracking = false;
      _loggedIn = false;
      _driverId = null;
      _driverProfile = null;
      _tripId = null;
      _tripData = null;
      _editingProfile = false;
    });

    if (message != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(message), duration: const Duration(seconds: 6)),
      );
    }
  }

  void _addLog(String message) {
    setState(() {
      _logs.insert(0, LogEntry(message, DateTime.now()));
      if (_logs.length > 60) _logs.removeLast();
    });
  }

  void _copyDni() {
    final dni = _driverProfile?['dni'] as String?;
    if (dni == null) return;
    Clipboard.setData(ClipboardData(text: dni));
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('DNI copiado')),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    if (!_loggedIn) {
      if (_showRegister) {
        return DriverRegistrationScreen(
          onDone: () => _afterAuthResolved(claimSession: true),
          onGoToLogin: () => setState(() => _showRegister = false),
        );
      }
      return LoginScreen(
        onLoggedIn: () => _afterAuthResolved(claimSession: true),
        onGoToRegister: () => setState(() => _showRegister = true),
      );
    }

    final approvalStatus = _driverProfile?['approvalStatus'] as String?;
    if (approvalStatus != 'approved') {
      return PendingApprovalScreen(
        profile: _driverProfile!,
        onLoggedOut: () => _clearSessionAndReturnToLogin(),
        onResubmitted: _afterAuthResolved,
      );
    }

    if (_editingProfile) {
      return Scaffold(
        appBar: AppBar(
          title: const Text('Editar mis datos'),
          leading: IconButton(
            icon: const Icon(Icons.close),
            onPressed: () => setState(() => _editingProfile = false),
          ),
        ),
        body: Column(
          children: [
            Expanded(child: _buildProfileForm()),
            SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
                child: SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: _logout,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.red.shade600,
                      foregroundColor: Colors.white,
                      minimumSize: const Size.fromHeight(48),
                    ),
                    child: const Text('Cerrar sesión', style: TextStyle(fontWeight: FontWeight.w600)),
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    }

    if (!_showingMainScreen) {
      return ActiveTripScreen(
        trip: _tripData!,
        tripId: _tripId!,
        currentLatLng: _currentLatLng,
        onFinished: () => setState(() { _tripId = null; _tripData = null; }),
      );
    }

    // Mapa a pantalla completa con overlays flotantes (perfil, estado,
    // registro de actividad, boton de turno) -- mismo patron visual que
    // Uber Conductor, en vez del AppBar + mapa chico + lista de logs
    // siempre visible que tenia antes.
    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(child: _buildMap()),
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                child: Column(
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        _circleIconButton(
                          icon: Icons.person,
                          tooltip: 'Editar mis datos',
                          onTap: () => setState(() => _editingProfile = true),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: _statusPill(),
                        ),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            _circleIconButton(
                              icon: Icons.receipt_long_outlined,
                              tooltip: 'Registro de actividad',
                              onTap: _showActivityLog,
                            ),
                            const SizedBox(height: 8),
                            const SupportButton(),
                          ],
                        ),
                      ],
                    ),
                    if (_permissionWarning != null) ...[
                      const SizedBox(height: 10),
                      _permissionBanner(_permissionWarning!),
                    ],
                  ],
                ),
              ),
            ),
          ),
          Positioned(
            left: 20,
            right: 20,
            bottom: 0,
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: _buildShiftButton(),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _circleIconButton({required IconData icon, required String tooltip, required VoidCallback onTap}) {
    return Material(
      color: Colors.white,
      shape: const CircleBorder(),
      elevation: 3,
      child: IconButton(
        icon: Icon(icon, color: Colors.black87),
        tooltip: tooltip,
        onPressed: onTap,
      ),
    );
  }

  Widget _statusPill() {
    final online = _tracking;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(999),
        boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 8, offset: Offset(0, 2))],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: online ? Colors.green : Colors.grey,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            online ? 'En línea' : 'Fuera de turno',
            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
          ),
        ],
      ),
    );
  }

  // Solo se muestra si falta algo -- un conductor con todo en orden no
  // deberia ver nada de esto, igual que la app real de Uber Conductor no
  // muestra detalles tecnicos salvo que haya un problema.
  String? get _permissionWarning {
    if (_notificationStatus?.isGranted != true) {
      return 'Faltan permisos de notificaciones: el rastreo puede detenerse. Toca para activarlos.';
    }
    if (_alwaysStatus?.isGranted != true) {
      return 'Ubicación no está en "Todo el tiempo": el rastreo puede detenerse al minimizar. Toca para revisar.';
    }
    return null;
  }

  Widget _permissionBanner(String message) {
    return GestureDetector(
      onTap: _requestPermissions,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.amber.shade50,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.amber.shade300),
        ),
        child: Row(
          children: [
            Icon(Icons.warning_amber_rounded, color: Colors.amber.shade800, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Text(message, style: TextStyle(color: Colors.amber.shade900, fontSize: 12.5)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildShiftButton() {
    if (_tracking) {
      return SizedBox(
        width: double.infinity,
        child: ElevatedButton.icon(
          onPressed: _endShift,
          icon: const Icon(Icons.pause_circle_filled),
          label: const Text('Terminar turno', style: TextStyle(fontWeight: FontWeight.w600)),
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.black,
            foregroundColor: Colors.white,
            minimumSize: const Size.fromHeight(56),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
            elevation: 4,
          ),
        ),
      );
    }
    return SizedBox(
      width: double.infinity,
      child: ElevatedButton.icon(
        onPressed: _startShift,
        icon: const Icon(Icons.play_circle_fill),
        label: const Text('Reintentar inicio de turno', style: TextStyle(fontWeight: FontWeight.w600)),
        style: ElevatedButton.styleFrom(
          backgroundColor: Colors.orange.shade800,
          foregroundColor: Colors.white,
          minimumSize: const Size.fromHeight(56),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
          elevation: 4,
        ),
      ),
    );
  }

  void _showActivityLog() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.only(topLeft: Radius.circular(20), topRight: Radius.circular(20)),
      ),
      builder: (context) {
        return SizedBox(
          height: MediaQuery.of(context).size.height * 0.6,
          child: Column(
            children: [
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('Registro de actividad', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              ),
              _buildStatusChips(),
              const Divider(height: 1),
              Expanded(child: _buildLogList()),
            ],
          ),
        );
      },
    );
  }

  Widget _buildProfileForm() {
    return Form(
      key: _profileFormKey,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text(
            'Solo puedes actualizar tu número de teléfono. Para corregir tu nombre, edad o placa, contacta a soporte.',
            style: TextStyle(color: Colors.grey, fontSize: 13),
          ),
          const SizedBox(height: 16),
          _profileField(_nameCtrl, 'Nombre completo', editable: false),
          _profileField(_ageCtrl, 'Edad', isNumber: true, editable: false),
          _profileField(_plateCtrl, 'Número de placa', editable: false),
          _profileField(_phoneCtrl, 'Teléfono (ej. +51987654321)'),
          const SizedBox(height: 20),
          ElevatedButton(
            onPressed: _savingProfile ? null : _saveProfile,
            style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            child: _savingProfile
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Text('Guardar cambios'),
          ),
        ],
      ),
    );
  }

  Widget _profileField(TextEditingController ctrl, String label, {bool isNumber = false, bool editable = true}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: TextFormField(
        controller: ctrl,
        enabled: editable,
        keyboardType: isNumber ? TextInputType.number : TextInputType.text,
        decoration: InputDecoration(
          labelText: label,
          filled: !editable,
          fillColor: editable ? null : Colors.grey.shade100,
        ),
        validator: (v) {
          if (v == null || v.trim().isEmpty) return 'Requerido';
          if (isNumber && int.tryParse(v.trim()) == null) return 'Debe ser un número';
          return null;
        },
      ),
    );
  }

  Widget _buildStatusChips() {
    return Container(
      width: double.infinity,
      color: Colors.grey.shade100,
      padding: const EdgeInsets.all(10),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        children: [
          _chip('DNI: ${_driverProfile?['dni'] ?? '-'}', Colors.blueGrey, onTap: _copyDni),
          _chip(
            'Ubicación: ${_permissionLabel()}',
            _alwaysStatus?.isGranted == true ? Colors.green : Colors.orange,
          ),
          _chip(
            'Notificaciones: ${_notificationStatus?.isGranted == true ? 'OK' : 'Falta'}',
            _notificationStatus?.isGranted == true ? Colors.green : Colors.red,
          ),
          _chip(_tracking ? 'En turno' : 'Fuera de turno', _tracking ? Colors.green : Colors.grey),
        ],
      ),
    );
  }

  String _permissionLabel() {
    if (_alwaysStatus?.isGranted == true) return 'Siempre';
    if (_whenInUseStatus?.isGranted == true) return 'Solo en uso';
    return 'No otorgado';
  }

  Widget _chip(String label, Color color, {VoidCallback? onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Chip(
        label: Text(label, style: const TextStyle(color: Colors.white, fontSize: 12)),
        backgroundColor: color,
      ),
    );
  }

  Widget _buildMap() {
    final center = _currentLatLng ?? const LatLng(19.4326, -99.1332);
    return GoogleMap(
      initialCameraPosition: CameraPosition(target: center, zoom: 15),
      onMapCreated: (controller) => _mapController = controller,
      myLocationEnabled: true,
      myLocationButtonEnabled: true,
      zoomControlsEnabled: false,
      // Deja libre la franja de arriba (perfil/estado/log) y la de abajo
      // (boton de turno) para que el control nativo de "mi ubicacion" no
      // quede tapado por los overlays flotantes.
      padding: const EdgeInsets.only(top: 110, bottom: 110),
      markers: _currentLatLng == null
          ? {}
          : {
              Marker(
                markerId: const MarkerId('me'),
                position: _currentLatLng!,
              ),
            },
    );
  }

  Widget _buildLogList() {
    if (_logs.isEmpty) {
      return const Center(child: Text('Sin actividad todavía.'));
    }
    return ListView.builder(
      itemCount: _logs.length,
      itemBuilder: (context, index) {
        final entry = _logs[index];
        final time = '${entry.time.hour.toString().padLeft(2, '0')}:'
            '${entry.time.minute.toString().padLeft(2, '0')}:'
            '${entry.time.second.toString().padLeft(2, '0')}';
        return ListTile(
          dense: true,
          leading: Text(time, style: const TextStyle(fontSize: 12, color: Colors.grey)),
          title: Text(entry.message, style: const TextStyle(fontSize: 13)),
        );
      },
    );
  }
}
