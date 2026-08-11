import 'dart:async';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart'
    show MapboxOptions;
import 'package:permission_handler/permission_handler.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'config.dart';
import 'screens/active_trip_screen.dart';
import 'screens/driver_registration_screen.dart';
import 'screens/login_screen.dart';
import 'screens/pending_approval_screen.dart';
import 'services/auth_service.dart';
import 'services/driver_profile_service.dart';
import 'services/location_service.dart';
import 'services/map_adapter.dart';
import 'services/manufacturer_protection_service.dart';
import 'services/notification_service.dart';
import 'services/notification_inbox_service.dart';
import 'services/push_service.dart';
import 'services/session_service.dart';
import 'services/trip_service.dart';
import 'services/update_service.dart';
import 'widgets/support_button.dart';
import 'theme/app_theme.dart';

bool get _supportsMobileServices =>
    !kIsWeb &&
    (defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  if (!kIsWeb && AppConfig.mapboxAccessToken.isNotEmpty) {
    MapboxOptions.setAccessToken(AppConfig.mapboxAccessToken);
  }

  // En web solo necesitamos revisar la interfaz local. Estas integraciones
  // dependen de Firebase/Android y no deben bloquear el arranque del preview.
  if (_supportsMobileServices) {
    await LocationService.initialize();
    await NotificationService.initialize();
    await PushService.initialize();
  }
  runApp(const FleetDriverApp());
}

class FleetDriverApp extends StatelessWidget {
  const FleetDriverApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'APL Conductores',
      theme: buildAppTheme(),
      home: const _UpdateGate(
        appName: 'la app de conductores',
        child: DriverHomePage(),
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
              Text('Actualización obligatoria',
                  style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 12),
              Text(
                  'Hay una nueva versión de ${widget.appName}. Descárgala e instálala para continuar.',
                  textAlign: TextAlign.center),
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: _openingDownload ? null : _downloadUpdate,
                child: Text(_openingDownload
                    ? 'Abriendo descarga…'
                    : 'Actualizar ahora'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class DriverHomePage extends StatefulWidget {
  const DriverHomePage({super.key});

  @override
  State<DriverHomePage> createState() => _DriverHomePageState();
}

class _DriverHomePageState extends State<DriverHomePage>
    with WidgetsBindingObserver {
  MapboxMapController? _mapController;
  LatLng? _currentLatLng;

  bool _tracking = false;
  bool _startingShift = false;
  bool _loading = true;
  String? _driverId;
  PermissionStatus? _alwaysStatus;
  PermissionStatus? _notificationStatus;
  PermissionStatus? _batteryStatus;

  // Sesion por correo/contraseña (persiste entre aperturas de la app, a
  // diferencia del DNI+rostro anterior que se re-pedia siempre).
  bool _loggedIn = false;
  bool _showRegister = false;
  Map<String, dynamic>? _driverProfile;

  bool _editingProfile = false;
  bool _savingProfile = false;
  String _versionLabel = '';

  final _profileFormKey = GlobalKey<FormState>();
  final _nameCtrl = TextEditingController();
  final _ageCtrl = TextEditingController();
  final _plateCtrl = TextEditingController();
  final _vehicleBrandCtrl = TextEditingController();
  final _vehicleTypeCtrl = TextEditingController();
  final _vehicleColorCtrl = TextEditingController();
  final _vehicleSeatsCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();

  // Estado de viajes: se consulta cada 5s si el conductor tiene un
  // currentTripId asignado automaticamente por Cloud Functions (sin pedirle
  // confirmacion), y se muestra la pantalla de "viaje activo" (He llegado
  // -> Pasajero a bordo -> Finalizar).
  Timer? _tripPollTimer;
  bool _tripPollInFlight = false;
  String? _tripId;
  Map<String, dynamic>? _tripData;

  // Poll independiente del de viajes (corre aprobado o no): detecta si otro
  // telefono inicio sesion con la misma cuenta y, si es asi, cierra esta
  // sesion solo (ver _checkSessionStillActive).
  Timer? _sessionCheckTimer;
  bool _locationReadInFlight = false;
  bool _shiftReconcileInFlight = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _bootstrap();
    _loadAppVersion();

    if (_supportsMobileServices) {
      try {
        FlutterBackgroundService().on('location_update').listen((event) {
          if (event == null) return;
          final lat = (event['lat'] as num?)?.toDouble();
          final lng = (event['lng'] as num?)?.toDouble();
          if (lat == null ||
              lng == null ||
              !LocationService.isUsableCoordinates(lat, lng)) {
            return;
          }
          _applyCurrentLocation(LatLng(lat, lng));
        });
      } catch (_) {
        // En previews de escritorio y tests el plugin no tiene plataforma.
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!_supportsMobileServices) return;

    if (state == AppLifecycleState.resumed) {
      // Reconoce avisos antiguos al volver a la app. El servicio GPS tiene
      // otra notificacion y no se cancela aqui.
      unawaited(NotificationService.acknowledgeAllAssigned());
      if (_tracking) {
        unawaited(_setScreenAwake(true));
        unawaited(_resumeTrackingAfterLifecycle());
      }
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      // La pantalla solo debe permanecer encendida mientras el conductor
      // esta usando la app. El servicio foreground continua en segundo plano.
      unawaited(_setScreenAwake(false));
    }
  }

  Future<void> _setScreenAwake(bool enabled) async {
    if (!_supportsMobileServices) return;
    try {
      await WakelockPlus.toggle(enable: enabled);
    } catch (_) {
      // El bloqueo de pantalla es una mejora; nunca debe impedir el GPS.
    }
  }

  Future<void> _resumeTrackingAfterLifecycle() async {
    if (!_tracking || _driverId == null) return;
    try {
      if (!await LocationService.isRunning()) {
        await LocationService.start();
      }
      final position = await LocationService.sendCurrentLocationNow();
      if (position != null) {
        _applyCurrentLocation(
          LatLng(position.latitude, position.longitude),
          recenter: false,
        );
      }
    } catch (error) {
      _addLog('No se pudo reanudar el GPS al volver a la app: $error');
    }
  }

  Future<void> _loadAppVersion() async {
    final info = await PackageInfo.fromPlatform();
    if (mounted) {
      setState(() =>
          _versionLabel = 'Versión ${info.version} (${info.buildNumber})');
    }
  }

  // Misma condicion que build() usa para decidir si se muestra la
  // pantalla principal de rastreo (con su mapa) en vez de las
  // pantallas de viaje entrante/activo.
  bool get _showingMainScreen {
    final tripStatus = _tripData?['status'] as String?;
    if (_tripId != null &&
        _tripData != null &&
        (tripStatus == 'accepted' ||
            tripStatus == 'arrived_at_pickup' ||
            tripStatus == 'in_progress')) {
      return false;
    }
    return true;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_setScreenAwake(false));
    _tripPollTimer?.cancel();
    _sessionCheckTimer?.cancel();
    _nameCtrl.dispose();
    _ageCtrl.dispose();
    _plateCtrl.dispose();
    _vehicleBrandCtrl.dispose();
    _vehicleTypeCtrl.dispose();
    _vehicleColorCtrl.dispose();
    _vehicleSeatsCtrl.dispose();
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
    if (_supportsMobileServices) {
      try {
        if (await LocationService.isRunning()) LocationService.stop();
      } catch (_) {
        // El plugin no esta disponible fuera de Android/iOS.
      }
    }

    try {
      await _refreshPermissionStatus();
    } catch (_) {
      // Los permisos nativos no existen en previews de escritorio/tests.
    }

    // Con la app visible, el push llega por aqui (no por el handler de
    // background): en vez de esperar el proximo tick de 5s, se consulta el
    // viaje de inmediato. El aviso sonoro lo pone _pollForTrip, que ya
    // deduplica por tripId.
    if (_supportsMobileServices) {
      FirebaseMessaging.onMessage.listen((message) async {
        switch (message.data['type']) {
          case 'trip_assigned':
            await NotificationService.showTripAssigned(
              tripId: message.data['tripId']?.toString(),
              scheduledPickupLabel:
                  message.data['scheduledPickupLabel']?.toString(),
            );
            await _pollForTrip(suppressAssignedNotification: true);
            break;
          case 'trip_updated':
            await NotificationService.showTripUpdated(
              tripId: message.data['tripId']?.toString(),
              destinationAddress:
                  message.data['destinationAddress']?.toString(),
            );
            await _pollForTrip();
            break;
          case 'trip_cancelled':
            await NotificationService.showTripCancelled(
              tripId: message.data['tripId']?.toString(),
              reason: message.data['reason']?.toString(),
            );
            if (_tripId == message.data['tripId']) {
              if (mounted) {
                setState(() {
                  _tripId = null;
                  _tripData = null;
                });
              }
            }
            await _pollForTrip();
            break;
          case 'place_assigned':
            _refreshAssignedPlace(
              message.data['placeName'] as String? ?? 'un lugar',
              message.data['placeType'] as String? ?? 'Lugar',
            );
            break;
          case 'approval_status':
            await NotificationInboxService.recordApproval(
              status: message.data['status']?.toString() ?? '',
              reason: message.data['rejectionReason']?.toString() ?? '',
              rejectionFieldKeys:
                  message.data['rejectionFieldKeys']?.toString() ?? '',
              reviewedAt: message.data['reviewedAt']?.toString() ?? '',
            );
            // Refresca el perfil para que la pantalla de "pendiente de
            // aprobacion" reaccione sin que el conductor tenga que reabrir
            // la app.
            _afterAuthResolved();
            final status = message.data['status'];
            if (status == 'approved') {
              NotificationService.showSimple(
                'Cuenta aprobada',
                'Ya puedes empezar a recibir viajes.',
              );
            } else if (status == 'rejected') {
              final reason = message.data['rejectionReason'] as String? ?? '';
              NotificationService.showSimple(
                'Registro rechazado',
                reason.isNotEmpty
                    ? reason
                    : 'Revisa tus documentos e intenta de nuevo.',
              );
            }
            break;
          case 'driver_suspended':
            final reason = message.data['reason']?.toString() ?? '';
            await _afterAuthResolved();
            NotificationService.showSimple(
              'Cuenta suspendida',
              reason.isNotEmpty
                  ? reason
                  : 'Comunícate con operaciones para más información.',
            );
            break;
        }
      });
    }

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
      if (claimSession && !AppConfig.useVpsBackend) {
        sessionId = await SessionService.startNewSession();
        await DriverProfileService.claimSession(sessionId);
      } else {
        sessionId = await SessionService.localSessionId();
      }

      final profile = await DriverProfileService.fetchProfile(uid);

      if (profile == null) {
        // Cuenta creada pero sin perfil final (por ejemplo, la app se cerró
        // durante una subida). Vuelve al formulario de registro; al ingresar
        // las mismas credenciales se recupera el mismo UID y se reanuda.
        await AuthService.logout();
        setState(() {
          _loggedIn = false;
          _showRegister = true;
          _loading = false;
        });
        return;
      }

      // Reinicio en frio con una sesion que ya fue reemplazada por otro
      // telefono mientras esta app estaba cerrada: no se llega a mostrar
      // nada, se cierra de una vez en vez de esperar el primer tick del
      // poll periodico de abajo.
      if (!claimSession && !AppConfig.useVpsBackend) {
        final remoteSessionId = profile['activeSessionId'] as String?;
        if (remoteSessionId != null &&
            sessionId != null &&
            remoteSessionId != sessionId) {
          await AuthService.logout();
          await SessionService.clear();
          setState(() {
            _loggedIn = false;
            _loading = false;
          });
          return;
        }
      }

      await NotificationInboxService.rememberDriverUid(uid);
      await NotificationInboxService.recordApproval(
        status: profile['approvalStatus']?.toString() ?? '',
        reason: profile['rejectionReason']?.toString() ?? '',
        rejectionFieldKeys: profile['rejectionFieldKeys']?.toString() ?? '',
        reviewedAt: profile['reviewedAt']?.toString() ?? '',
      );

      if (_supportsMobileServices) await PushService.registerToken();

      _nameCtrl.text = profile['name']?.toString() ?? '';
      _ageCtrl.text = profile['age']?.toString() ?? '';
      _plateCtrl.text = profile['plate']?.toString() ?? '';
      _vehicleBrandCtrl.text = profile['vehicleBrand']?.toString() ?? '';
      _vehicleTypeCtrl.text = profile['vehicleType']?.toString() ?? '';
      _vehicleColorCtrl.text = profile['vehicleColor']?.toString() ?? '';
      _vehicleSeatsCtrl.text = profile['vehicleSeats']?.toString() ?? '';
      _phoneCtrl.text = profile['phone']?.toString() ?? '';

      setState(() {
        _driverId = uid;
        _driverProfile = profile;
        _loggedIn = true;
        _tracking = profile['turno_activo'] == true ||
            (profile['turno_activo'] == null &&
                (profile['status'] == 'online' || profile['status'] == 'busy'));
        _loading = false;
      });

      _sessionCheckTimer?.cancel();
      _sessionCheckTimer = Timer.periodic(
          const Duration(seconds: 20), (_) => _checkSessionStillActive());

      final canOperate = profile['approvalStatus'] == 'approved' &&
          profile['suspended'] != true;
      if (canOperate && _supportsMobileServices) {
        // La pantalla obtiene una posicion inicial propia y no depende de
        // que el servicio en segundo plano ya haya emitido su primer evento.
        unawaited(_refreshCurrentLocation());
      }

      if (canOperate) {
        _tripPollTimer?.cancel();
        _tripPollTimer =
            Timer.periodic(const Duration(seconds: 5), (_) => _pollForTrip());
        _pollForTrip();
        // El turno es una decision explicita del conductor y vive separado
        // del estado de conexion. Si el proceso se cerro, se reconecta y
        // reanuda el GPS sin pedir un nuevo inicio de turno.
        final shiftWasActive = profile['turno_activo'] == true ||
            (profile['turno_activo'] == null &&
                (profile['status'] == 'online' || profile['status'] == 'busy'));
        if (shiftWasActive) unawaited(_startShift(resume: true));
      } else {
        await _lockUnapprovedDriver(uid);
      }
    } catch (e) {
      setState(() {
        _loggedIn = false;
        _loading = false;
      });
    }
  }

  // Un conductor pendiente o rechazado conserva la sesion para poder leer el
  // motivo y volver a enviar documentos, pero nunca puede conservar estado
  // operativo, GPS ni polling de viajes.
  Future<void> _lockUnapprovedDriver(String uid) async {
    _tripPollTimer?.cancel();
    _tripPollTimer = null;
    if (_supportsMobileServices) {
      LocationService.stop();
      unawaited(_setScreenAwake(false));
    }

    if (_tracking || _tripId != null || _tripData != null) {
      if (mounted) {
        setState(() {
          _tracking = false;
          _tripId = null;
          _tripData = null;
        });
      }
    }

    try {
      await TripService.setAvailability(uid, online: false);
    } catch (_) {
      // El backend tambien limpia el estado al procesar un rechazo.
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
      final wasApproved = _driverProfile?['approvalStatus'] == 'approved' &&
          _driverProfile?['suspended'] != true;
      final profile = await DriverProfileService.fetchProfile(_driverId!);
      if (profile != null) {
        final oldPlace =
            ((_driverProfile?['assignedPlace'] as Map?)?['name'] ?? '')
                .toString();
        final newPlace =
            ((profile['assignedPlace'] as Map?)?['name'] ?? '').toString();
        if (mounted) setState(() => _driverProfile = profile);

        final isApproved = profile['approvalStatus'] == 'approved' &&
            profile['suspended'] != true;
        if (wasApproved && !isApproved) {
          await _lockUnapprovedDriver(_driverId!);
        } else if (!wasApproved && isApproved) {
          _tripPollTimer?.cancel();
          _tripPollTimer =
              Timer.periodic(const Duration(seconds: 5), (_) => _pollForTrip());
          _pollForTrip();
          PushService.registerToken();
        }

        if (newPlace.isNotEmpty && newPlace != oldPlace) {
          final type = ((profile['assignedPlace'] as Map?)?['type'] ?? 'Lugar')
              .toString();
          await NotificationService.showPlaceAssigned(newPlace, type);
        }

        // El worker de heartbeat puede haber cerrado la conexion del servidor
        // mientras este telefono seguia mostrando el turno localmente activo.
        // Si el conductor no pulso "Terminar turno", vuelve a registrar la
        // disponibilidad y reanuda el servicio GPS sin pedir otra accion.
        await _reconcileRemoteShift(profile);
      }
      final remoteSessionId = profile?['activeSessionId'] as String?;
      final localSessionId = await SessionService.localSessionId();
      if (remoteSessionId != null &&
          localSessionId != null &&
          remoteSessionId != localSessionId) {
        await _clearSessionAndReturnToLogin(
          message:
              'Tu sesión se cerró porque iniciaste sesión en otro dispositivo.',
        );
      }
    } catch (_) {
      // Fallo de red puntual: se reintenta en el siguiente tick.
    }
  }

  bool _remoteShiftIsActive(Map<String, dynamic> profile) {
    return profile['turno_activo'] == true ||
        profile['status'] == 'online' ||
        profile['status'] == 'busy';
  }

  bool _remoteConnectionIsActive(Map<String, dynamic> profile) {
    return profile['status'] == 'online' || profile['status'] == 'busy';
  }

  Future<void> _reconcileRemoteShift(Map<String, dynamic> profile) async {
    if (_driverId == null ||
        !_tracking ||
        _startingShift ||
        _shiftReconcileInFlight) {
      return;
    }

    final shiftIsActive = _remoteShiftIsActive(profile);
    final heartbeatClosedShift =
        profile['ultimo_motivo_desconexion'] == 'HEARTBEAT';
    final needsReconnect = shiftIsActive &&
        (!_remoteConnectionIsActive(profile) ||
            profile['estado_conexion'] != 'ONLINE');

    // Un cierre manual no debe reabrirse silenciosamente. Solo se recuperan
    // turnos que el conductor dejo abiertos o que cerro el detector automatico
    // por perdida temporal del heartbeat.
    if (!needsReconnect && !(heartbeatClosedShift && !shiftIsActive)) {
      if (!shiftIsActive) {
        if (_supportsMobileServices) {
          LocationService.stop();
          unawaited(_setScreenAwake(false));
        }
        if (mounted) setState(() => _tracking = false);
        _addLog('El servidor cerro el turno; el rastreo se detuvo.');
      }
      return;
    }

    _shiftReconcileInFlight = true;
    try {
      await TripService.setAvailability(_driverId!, online: true);
      if (mounted) setState(() => _tracking = true);
      _addLog('Conexion GPS recuperada automaticamente.');
      if (_supportsMobileServices) {
        await LocationService.start();
        unawaited(LocationService.sendCurrentLocationNow());
      }
    } catch (error) {
      _addLog('No se pudo recuperar la conexion GPS: $error');
    } finally {
      _shiftReconcileInFlight = false;
    }
  }

  Future<void> _refreshAssignedPlace(String name, String type) async {
    if (_driverId == null) return;
    try {
      final profile = await DriverProfileService.fetchProfile(_driverId!);
      if (profile != null && mounted) setState(() => _driverProfile = profile);
    } catch (_) {
      // El aviso igualmente llega; el siguiente chequeo actualizara la ficha.
    }
    await NotificationService.showPlaceAssigned(name, type);
  }

  bool _tripViewChanged(Map<String, dynamic> next) {
    final current = _tripData;
    if (current == null) return true;
    const keys = [
      'status',
      'pickupLat',
      'pickupLng',
      'pickupAddress',
      'destinationLat',
      'destinationLng',
      'destinationAddress',
      'passengerName',
      'passengerPhone',
      'passengerCount',
      'scheduledPickupLabel',
      'driverId',
    ];
    return keys.any((key) => current[key] != next[key]);
  }

  Future<void> _pollForTrip({bool suppressAssignedNotification = false}) async {
    if (_driverId == null ||
        _driverProfile?['approvalStatus'] != 'approved' ||
        _driverProfile?['suspended'] == true) {
      return;
    }
    if (_tripPollInFlight) return;
    _tripPollInFlight = true;
    try {
      final driverNode = await TripService.getMyDriverNode(_driverId!);
      final tripId = driverNode?['currentTripId'] as String?;

      if (tripId == null) {
        if (_tripId != null) {
          setState(() {
            _tripId = null;
            _tripData = null;
          });
        }
        return;
      }

      final trip = await TripService.getTrip(tripId);
      if (trip == null) {
        if (_tripId != null) {
          setState(() {
            _tripId = null;
            _tripData = null;
          });
        }
        return;
      }

      const activeStatuses = [
        'accepted',
        'arrived_at_pickup',
        'in_progress',
      ];
      if (trip['driverId'] != _driverId ||
          !activeStatuses.contains(trip['status']) ||
          _driverProfile?['approvalStatus'] != 'approved' ||
          _driverProfile?['suspended'] == true) {
        if (_tripId != null) {
          setState(() {
            _tripId = null;
            _tripData = null;
          });
        }
        return;
      }

      // Viaje nuevo (no uno que ya se estaba mostrando): avisa con sonido y
      // vibracion, ya que la asignacion es automatica y el conductor podria
      // no estar mirando la pantalla en ese momento. Solo si la app esta
      // visible: minimizada o cerrada, el aviso lo da el handler de FCM en
      // background (push_service.dart) y avisar aqui tambien duplicaria la
      // voz. El estado del viaje se actualiza igual, para que al volver a
      // la app ya este la pantalla del viaje activo.
      if (!suppressAssignedNotification &&
          _tripId != tripId &&
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
        await NotificationService.showTripAssigned(
          tripId: tripId,
          scheduledPickupLabel: trip['scheduledPickupLabel'] as String?,
        );
      }

      if (_tripId != tripId || _tripViewChanged(trip)) {
        setState(() {
          _tripId = tripId;
          _tripData = trip;
        });
        // Showing the active-trip screen acknowledges the repeating alert;
        // until this point the foreground service keeps reminding the driver.
        await NotificationService.acknowledgeTripAssigned(tripId);
      }
    } catch (_) {
      // Fallo de red puntual: se reintenta en el siguiente tick del timer.
    } finally {
      _tripPollInFlight = false;
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
      await DriverProfileService.updatePhone(phone: phone);
      setState(() {
        _driverProfile = {
          ...?_driverProfile,
          'phone': phone,
        };
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
    if (!_supportsMobileServices) return;

    await Permission.locationWhenInUse.status;
    final always = await Permission.locationAlways.status;
    final notification = await Permission.notification.status;
    final battery = defaultTargetPlatform == TargetPlatform.android
        ? await Permission.ignoreBatteryOptimizations.status
        : null;
    setState(() {
      _alwaysStatus = always;
      _notificationStatus = notification;
      _batteryStatus = battery;
    });
  }

  Future<bool> _requestPermissions() async {
    if (!_supportsMobileServices) return true;

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
        _addLog(
            'Permiso de notificaciones bloqueado permanentemente. Abre Ajustes de la app y actívalo a mano.');
        await openAppSettings();
      } else {
        _addLog(
            'Permiso de notificaciones denegado. Es obligatorio: sin el, Android cierra la app al iniciar el rastreo.');
      }
      await _refreshPermissionStatus();
      return false;
    }

    if (defaultTargetPlatform == TargetPlatform.android) {
      final battery = await Permission.ignoreBatteryOptimizations.request();
      if (!battery.isGranted) {
        _addLog(
            'Ahorro de batería activo: el sistema puede suspender el rastreo al bloquear la pantalla.');
      }
    }

    final alwaysStatus = await Permission.locationAlways.status;
    if (!alwaysStatus.isGranted) {
      if (!mounted) return false;
      final understood = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Ubicación durante el turno'),
          content: const Text(
            'Para enviar la posición del vehículo al centro de operaciones y al pasajero asignado, APL Logistics necesita tu ubicación precisa durante el turno, incluso cuando minimices la app o bloquees la pantalla. No usamos esta ubicación para publicidad.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Ahora no'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Continuar'),
            ),
          ],
        ),
      );
      if (understood != true || !mounted) {
        await _refreshPermissionStatus();
        return false;
      }
    }

    final always = await Permission.locationAlways.request();
    await _refreshPermissionStatus();

    if (!always.isGranted) {
      _addLog(
          'Permiso "todo el tiempo" no otorgado. El rastreo en segundo plano puede detenerse al minimizar la app.');
    }

    return true;
  }

  // Arranca el rastreo automaticamente (sin que el conductor tenga que
  // presionar nada) apenas la sesion queda resuelta y aprobada. Si algun
  // permiso falta, queda mostrado en la barra de estado y el conductor
  // puede reintentar con el boton "Reintentar inicio de turno".
  Future<void> _startShift({bool resume = false}) async {
    if (_driverId == null || _startingShift || (!resume && _tracking)) return;
    if (mounted) setState(() => _startingShift = true);

    try {
      final granted = await _requestPermissions();
      if (!granted) {
        if (!resume && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
                content: Text(
                    'Concede los permisos necesarios para iniciar el turno.')),
          );
        }
        if (mounted) {
          setState(() {
            _tracking = false;
            _startingShift = false;
          });
        }
        return;
      }

      // Huawei/EMUI, MIUI, ColorOS y One UI aplican reglas adicionales que
      // Android no expone por permisos. Se muestran una vez por fabricante
      // para que el foreground service sobreviva con la pantalla apagada.
      if (defaultTargetPlatform == TargetPlatform.android && mounted) {
        await ManufacturerProtectionService.showIfNeeded(context);
      }

      await TripService.setAvailability(_driverId!, online: true);
    } catch (error) {
      _addLog('No se pudo iniciar la disponibilidad: $error');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text(
                  'No se pudo iniciar la disponibilidad. Revisa tu conexión e intenta nuevamente.')),
        );
      }
      if (mounted) {
        setState(() {
          _tracking = false;
          _startingShift = false;
        });
      }
      return;
    }

    if (!mounted) return;
    setState(() {
      _tracking = true;
      _startingShift = false;
    });
    unawaited(_setScreenAwake(true));
    _addLog(resume
        ? 'Turno reanudado: el cierre de la app no lo termino.'
        : 'Turno iniciado: rastreo GPS cada 5 segundos.');

    if (_supportsMobileServices) {
      // El servicio y el primer heartbeat no deben bloquear la interfaz.
      unawaited(_startLocationTracking());
    }
  }

  Future<void> _startLocationTracking() async {
    try {
      await LocationService.start();
      // Publica el primer heartbeat sin retrasar el cambio visual a
      // "En linea". El servicio en segundo plano continua cada 5 segundos.
      final reportedPosition = await LocationService.sendCurrentLocationNow();
      if (reportedPosition != null) {
        _applyCurrentLocation(
          LatLng(reportedPosition.latitude, reportedPosition.longitude),
        );
      } else {
        // El envio a Firebase puede completar sin devolver la posicion. La
        // pantalla igualmente necesita un fix local para pintar el vehiculo
        // y calcular la ruta del viaje.
        await _refreshCurrentLocation(recenter: false);
        _addLog('Turno conectado, pero aun no se pudo publicar el GPS.');
      }
    } catch (error) {
      _addLog('No se pudo iniciar el rastreo GPS: $error');
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
        (activeStatus == 'accepted' ||
            activeStatus == 'arrived_at_pickup' ||
            activeStatus == 'in_progress')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('No puedes terminar el turno con un viaje activo.')),
      );
      return;
    }

    if (_driverId != null) {
      try {
        await TripService.setAvailability(_driverId!, online: false);
      } catch (e) {
        _addLog('No se pudo actualizar disponibilidad: $e');
      }
    }

    if (_supportsMobileServices) {
      LocationService.stop();
      unawaited(_setScreenAwake(false));
    }
    _addLog('Turno terminado por el conductor.');

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
        (activeStatus == 'accepted' ||
            activeStatus == 'arrived_at_pickup' ||
            activeStatus == 'in_progress')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('No puedes cerrar sesión con un viaje activo.')),
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
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancelar')),
          TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Cerrar sesión')),
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

  Future<void> _deleteAccount() async {
    final activeStatus = _tripData?['status'] as String?;
    if (_tripId != null &&
        (activeStatus == 'accepted' ||
            activeStatus == 'arrived_at_pickup' ||
            activeStatus == 'in_progress')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content:
                Text('Finaliza el viaje activo antes de eliminar la cuenta.')),
      );
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Eliminar cuenta y datos'),
        content: const Text(
          'Se eliminarán tu perfil, documentos, ubicación y registros de viajes identificables. Esta acción no se puede deshacer.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Eliminar todo',
                style: TextStyle(color: AppColors.red)),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    try {
      if (_driverId != null) {
        await TripService.setAvailability(_driverId!, online: false);
      }
      if (_supportsMobileServices) {
        LocationService.stop();
        unawaited(_setScreenAwake(false));
      }
      await NotificationService.cancelAll();
      await AuthService.deleteCurrentAccount();
      await SessionService.clear();
      await _clearSessionAndReturnToLogin();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            content: Text(error.toString().replaceFirst('Exception: ', ''))),
      );
    }
  }

  Future<void> _openLegalUrl(String url) async {
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
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

    if (_supportsMobileServices) {
      LocationService.stop();
      unawaited(_setScreenAwake(false));
    }
    await NotificationService.cancelAll();
    await AuthService.logout();
    await SessionService.clear();

    if (!mounted) return;
    setState(() {
      _tracking = false;
      _loggedIn = false;
      _showRegister = false;
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
    // El registro ya no se muestra en la interfaz. No reconstruir el mapa
    // cada vez que llega un evento del servicio GPS.
    debugPrint('[Driver] $message');
  }

  void _applyCurrentLocation(LatLng location, {bool recenter = true}) {
    if (!mounted) return;
    setState(() => _currentLatLng = location);
    if (recenter && _showingMainScreen) {
      unawaited(_moveMapTo(location));
    }
  }

  Future<LatLng?> _refreshCurrentLocation({bool recenter = true}) async {
    if (!_supportsMobileServices || _locationReadInFlight) {
      return _currentLatLng;
    }
    _locationReadInFlight = true;
    try {
      final position = await LocationService.getCurrentPosition();
      if (position == null) return _currentLatLng;
      final location = LatLng(position.latitude, position.longitude);
      _applyCurrentLocation(location, recenter: recenter);
      return location;
    } catch (_) {
      return _currentLatLng;
    } finally {
      _locationReadInFlight = false;
    }
  }

  Future<void> _moveMapTo(LatLng location, {bool zoom = false}) async {
    if (!_showingMainScreen) return;
    final controller = _mapController;
    if (controller == null) return;
    try {
      await controller.animateCamera(zoom
          ? CameraUpdate.newLatLngZoom(location, 16)
          : CameraUpdate.newLatLng(location));
    } catch (_) {
      // El mapa puede estar reconstruyendose al cambiar entre pantallas.
    }
  }

  Future<void> _centerOnCurrentLocation() async {
    final location =
        _currentLatLng ?? await _refreshCurrentLocation(recenter: false);
    if (!mounted) return;
    if (location == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Aún no tenemos una ubicación GPS.')),
      );
      return;
    }
    await _moveMapTo(location, zoom: true);
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
    if (approvalStatus != 'approved' || _driverProfile?['suspended'] == true) {
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
                child: Column(
                  children: [
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: _logout,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.red.shade600,
                          foregroundColor: Colors.white,
                          minimumSize: const Size.fromHeight(48),
                        ),
                        child: const Text('Cerrar sesión',
                            style: TextStyle(fontWeight: FontWeight.w600)),
                      ),
                    ),
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton(
                        onPressed: _deleteAccount,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.red.shade700,
                          side: BorderSide(color: Colors.red.shade300),
                          minimumSize: const Size.fromHeight(48),
                        ),
                        child: const Text('Eliminar cuenta y datos'),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      alignment: WrapAlignment.center,
                      spacing: 16,
                      children: [
                        TextButton(
                          onPressed: () =>
                              _openLegalUrl(AppConfig.privacyPolicyUrl),
                          child: const Text('Privacidad'),
                        ),
                        TextButton(
                          onPressed: () =>
                              _openLegalUrl(AppConfig.deleteAccountUrl),
                          child: const Text('Ayuda para eliminar cuenta'),
                        ),
                      ],
                    ),
                    if (_versionLabel.isNotEmpty) ...[
                      const SizedBox(height: 10),
                      Text(
                        _versionLabel,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                            fontSize: 12, color: Colors.grey.shade600),
                      ),
                    ],
                  ],
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
        onTripStateConflict: _pollForTrip,
        onFinished: () => setState(() {
          _tripId = null;
          _tripData = null;
        }),
      );
    }

    // Mapa a pantalla completa con overlays flotantes (perfil, estado,
    // soporte y boton de turno) -- mismo patron visual que
    // Uber Conductor, en vez del AppBar + mapa chico.
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
                          tooltip: 'Editar numero telefonico',
                          onTap: () => setState(() => _editingProfile = true),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: _statusPill(),
                        ),
                        const Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            SupportButton(),
                          ],
                        ),
                      ],
                    ),
                    if (_permissionWarning != null) ...[
                      const SizedBox(height: 10),
                      _permissionBanner(_permissionWarning!),
                    ],
                    if (((_driverProfile?['assignedPlace'] as Map?)?['name'] ??
                            '')
                        .toString()
                        .isNotEmpty) ...[
                      const SizedBox(height: 10),
                      _assignedPlaceBanner(),
                    ],
                  ],
                ),
              ),
            ),
          ),
          Positioned(
            right: 20,
            bottom: 96,
            child: SafeArea(
              top: false,
              child: _circleIconButton(
                icon: Icons.my_location,
                tooltip: 'Centrar en mi ubicación',
                onTap: _centerOnCurrentLocation,
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

  Widget _circleIconButton(
      {required IconData icon,
      required String tooltip,
      required VoidCallback onTap}) {
    return Material(
      color: AppColors.paper,
      shape: const CircleBorder(),
      elevation: 3,
      child: IconButton(
        icon: Icon(icon, color: AppColors.ink),
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
        color: AppColors.paper,
        borderRadius: BorderRadius.circular(999),
        boxShadow: const [
          BoxShadow(color: Colors.black26, blurRadius: 8, offset: Offset(0, 2))
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: online ? AppColors.green : AppColors.muted,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            online ? 'En línea' : 'Desconectado',
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
    if (defaultTargetPlatform == TargetPlatform.android &&
        _batteryStatus?.isGranted != true) {
      return 'El ahorro de batería puede suspender el rastreo. Permite que APL Logistics funcione sin restricciones.';
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
            Icon(Icons.warning_amber_rounded,
                color: Colors.amber.shade800, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Text(message,
                  style:
                      TextStyle(color: Colors.amber.shade900, fontSize: 12.5)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _assignedPlaceBanner() {
    final place = Map<String, dynamic>.from(
        (_driverProfile?['assignedPlace'] as Map?) ?? const {});
    final name = place['name']?.toString() ?? '';
    final type = place['type']?.toString() ?? 'Lugar';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.inkSurface,
        borderRadius: BorderRadius.circular(14),
        boxShadow: const [
          BoxShadow(color: Colors.black26, blurRadius: 8, offset: Offset(0, 2)),
        ],
      ),
      child: Row(
        children: [
          const Icon(Icons.location_on, color: AppColors.lime, size: 26),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('$type asignado',
                    style: const TextStyle(
                        color: Colors.white70,
                        fontSize: 12,
                        fontWeight: FontWeight.w600)),
                const SizedBox(height: 2),
                Text(name,
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 17,
                        fontWeight: FontWeight.bold)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildShiftButton() {
    if (_startingShift) {
      return SizedBox(
        width: double.infinity,
        child: ElevatedButton.icon(
          onPressed: null,
          icon: const SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          label: const Text('Iniciando turno...',
              style: TextStyle(fontWeight: FontWeight.w600)),
          style: ElevatedButton.styleFrom(
            minimumSize: const Size.fromHeight(56),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          ),
        ),
      );
    }
    if (_tracking) {
      return SizedBox(
        width: double.infinity,
        child: ElevatedButton.icon(
          onPressed: _endShift,
          icon: const Icon(Icons.pause_circle_filled),
          label: const Text('Terminar turno',
              style: TextStyle(fontWeight: FontWeight.w600)),
          style: ElevatedButton.styleFrom(
            backgroundColor: AppColors.ink,
            foregroundColor: AppColors.paper,
            minimumSize: const Size.fromHeight(56),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
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
        label: const Text('Iniciar turno',
            style: TextStyle(fontWeight: FontWeight.w600)),
        style: ElevatedButton.styleFrom(
          backgroundColor: Colors.white,
          foregroundColor: AppColors.ink,
          side: const BorderSide(color: AppColors.line),
          minimumSize: const Size.fromHeight(56),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          elevation: 4,
        ),
      ),
    );
  }

  Widget _buildProfileForm() {
    return Form(
      key: _profileFormKey,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text(
            'Solo puedes editar tu número telefónico. Para corregir otros datos, contacta a soporte.',
            style: TextStyle(color: Colors.grey, fontSize: 13),
          ),
          const SizedBox(height: 16),
          _profileField(_nameCtrl, 'Nombre completo', editable: false),
          _profileField(_ageCtrl, 'Edad', isNumber: true, editable: false),
          _profileField(_vehicleColorCtrl, 'Color del vehículo',
              editable: false),
          _profileField(_vehicleBrandCtrl, 'Marca del vehículo',
              editable: false),
          _profileField(_vehicleTypeCtrl, 'Tipo de vehículo', editable: false),
          _profileField(_vehicleSeatsCtrl, 'Número de asientos',
              isNumber: true, editable: false),
          _profileField(_plateCtrl, 'Número de placa', editable: false),
          _profileField(_phoneCtrl, 'Teléfono (ej. +51987654321)'),
          const SizedBox(height: 20),
          ElevatedButton(
            onPressed: _savingProfile ? null : _saveProfile,
            style: ElevatedButton.styleFrom(
                minimumSize: const Size.fromHeight(48)),
            child: _savingProfile
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: Colors.white),
                  )
                : const Text('Guardar cambios'),
          ),
        ],
      ),
    );
  }

  Widget _profileField(TextEditingController ctrl, String label,
      {bool isNumber = false, bool editable = true}) {
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
          if (isNumber && int.tryParse(v.trim()) == null) {
            return 'Debe ser un número';
          }
          return null;
        },
      ),
    );
  }

  Widget _buildMap() {
    final center = _currentLatLng ?? const LatLng(19.4326, -99.1332);
    return MapboxMapView(
      initialCameraPosition: CameraPosition(target: center, zoom: 15),
      onMapCreated: (controller) {
        _mapController = controller;
        final location = _currentLatLng;
        if (location != null) unawaited(_moveMapTo(location));
      },
      // El marcador propio usa el icono de vehiculo; el punto azul nativo
      // duplicaria la posicion del conductor.
      myLocationEnabled: false,
      myLocationButtonEnabled: false,
      zoomControlsEnabled: false,
      // Deja libre la franja de arriba (perfil/estado) y la de abajo
      // (boton de turno) para que el control nativo de "mi ubicacion" no
      // quede tapado por los overlays flotantes.
      padding: const EdgeInsets.only(top: 110, bottom: 110),
      markers: _currentLatLng == null
          ? {}
          : {
              Marker(
                markerId: const MarkerId('me'),
                position: _currentLatLng!,
                icon: BitmapDescriptor.vehicleMarker,
                anchor: const Offset(0.5, 0.5),
              ),
            },
    );
  }
}
