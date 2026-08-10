# Progreso pruebas E2E — Entrega (2026-08-10)

> **Traspaso** para continuar sin fricción (Claude o Codex). Registra lo verificado,
> lo pendiente, los hallazgos y las notas técnicas necesarias para retomar.
> Complementa el plan: `.gstack/qa-reports/plan-pruebas-e2e-entrega.md`.
> Proyecto Firebase: `rastreoflota-53052`.

## 0. Cómo retomar (setup rápido)

```bash
export PATH="$LOCALAPPDATA/Android/Sdk/platform-tools:$PATH"
S=R5CY72078ZM            # DRIVER  (Samsung SM-S938B)  paquete apl.tucompras.com
H=45C7N19420000522       # PASAJERO (Huawei VOG-L04)   paquete apl.tucomprass.pasajero
D=WOMDqpodQEc0qvvVbCpMChVRFZ82   # UID del conductor de prueba (Auto CYV627, 4 asientos)
# Pantalla física 1080x2340. Screencap→leer→tap/type. Ver comandos en el plan.
```

- **Dashboard real:** `https://apl.tucomprass.com/` (NO el `*.web.app`). Ya queda
  **logueado en el Chrome de la PC** (usar claude-in-chrome → Browser 1). La navegación
  del Browser-pane a `apl.tucomprass.com` está **bloqueada**; y no se puede loguear con
  contraseña. Por eso los casos de dashboard se hacen en el Chrome de la PC.
- **GPS del pasajero:** debe tener permiso + GPS activo, si no usa una ubicación de
  respaldo lejana (p.ej. Plaza Dos de Mayo) que rompe el emparejamiento por cercanía.
  Se concedió por adb: `pm grant apl.tucomprass.pasajero android.permission.ACCESS_FINE_LOCATION`
  (+ COARSE), `location_mode=3`. Ubicación real de prueba: Villa Victoria / Surquillo
  (cerca del conductor).
- **Seguir un viaje:** `/drivers/$D/currentTripId` → `<TRIP>` → `/trips/<TRIP>`.

---

## 1. Resultados

| Caso | Estado | Evidencia / nota |
|---|---|---|
| **B** Pedir + asignación | ✅ | `searching`→`accepted`, `driverId=$D` |
| **AS1** 1–4 pax → Auto | ✅ | Asignó al Auto **CYV627 · 4 asientos** (pasajero lo ve) |
| **Notif asignación (voz)** | ✅ | `GoogleTTSServiceImpl: Synthesis request spa-ESP` + `tts is now playing` ~3s + sonido del canal de alerta |
| **Notif cambio de destino (voz)** | ✅ | TTS disparó al mover destino (17:40:27) |
| **D** Avance completo | ✅ | `arrived_at_pickup`→`in_progress`→`completed`; conductor liberado (`online`, `currentTripId=null`). *Ojo:* "Finalizar" está **geo-restringido** al destino; se movió el destino con "Modificar viaje" a la posición del conductor para desbloquearlo. |
| **Notif llegada** (`driver_arrived`) | ✅ | UI del pasajero sincroniza; confirmado también en segundo plano (ver §3) |
| **E** Calificación/incidencia (pasajero) | ✅ | "5/5 · Incidencia enviada" (Objeto perdido); `submitTripFeedback` OK |
| **K** Historial | ✅ | Actividad muestra el viaje completado con conductor/fecha |
| **G** Cancelación pasajero | ✅ | Canceló en "Buscando", volvió limpio a "Pedir un viaje" |
| **AS2** 5 pax → sin capacidad | ⚠️ | Exclusión por asientos OK (Auto de 4 **no** se asigna, `currentTripId=null`), pero la app queda en "Buscando" **sin mensaje** → hallazgo (§4) |
| **C** Dashboard monitoreo | ✅ | Dashboard muestra al conductor en vivo (Ever, CYV627, "En ruta de recogida"), auto en el mapa y panel VIAJE ACTUAL (pasajero, estado, recogida, destino, GPS fresco). El "0 vehículos" inicial es solo demora de carga. |
| **F** Cancelación admin | ✅ | Desde dashboard "Cancelar viaje" + prompt de motivo → `status=cancelled`, `cancelledBy="dashboard"`, `cancelReason` registrado, conductor liberado |
| **Notif segundo plano — conductor** | ✅ | Voz de asignación **con pantalla apagada/dozing** (ver §3) |
| **Notif segundo plano — pasajero** | ✅ | `driver_arrived` **con pantalla apagada/asleep** (ver §3) |

---

## 2. Pendientes (para continuar)

| Caso | Qué falta | Requisito |
|---|---|---|
| **I** Coordinador (crear/cancelar) | Crear viaje de coordinador (`createCoordinatorTrip`) desde la ruta de despacho y probar `cancelCoordinatorTrip`. Se estaba por navegar a la ruta de dispatch cuando se pausó. Ruta según plan: `dashboard/coordinator-dashboard/dispatch` (confirmar URL real en `apl.tucomprass.com`). | Chrome PC logueado |
| **E — lado admin** | Resolver/reabrir la incidencia "Objeto perdido" recién creada (`manageTripFeedback`) desde el dashboard. | Chrome PC logueado |
| **H** Auto-despacho | Re-agendar un viaje ~12–15 min y confirmar que `dispatchScheduledTrips` lo pasa a `accepted` ~10 min antes. La 1ª vez Renzo lo canceló (decía "no hay drivers" y "Reintentar" no funcionaba; probablemente por ubicación de respaldo lejana antes de activar GPS). | GPS real activo |
| **AS3** Multi-driver (asientos/cercanía) | Auto vs SUV dentro/fuera de anillos; ver reglas en el plan §3. | 1–2 teléfonos más con conductores de distinta capacidad |
| **J** Registro conductor | Registro con documentos → `pending_review` → aprobar/rechazar+motivo/reenviar. | Otro equipo |
| **Notif con app CERRADA (killed)** | Solo se probó minimizada + pantalla apagada (dozing/asleep). Falta con la app del conductor **cerrada por completo**. | — |

---

## 3. Notificaciones en segundo plano (VERIFICADO)

**Conductor — asignación con pantalla APAGADA/suspendido:**
- 18:15:03 pantalla off → `mWakefulness=Dozing`; 18:16:06 pedido; **18:16:12** (aún Dozing)
  `GoogleTTSServiceImpl: Synthesis request spa-ESP` + `tts is now playing` → la voz sonó
  vía `FlutterFirebaseMessagingBackgroundService` (FCM de datos de alta prioridad). Badge
  "6" en el ícono de APL Conductor. Al abrir, la app estaba en "En camino a recoger".

**Pasajero — `driver_arrived` con pantalla APAGADA/dormido:**
- Pasajero minimizado + `mWakefulness=Asleep`; al deslizar "he llegado" el conductor →
  18:20:14 `NotificationService enqueue pkg=apl.tucomprass.pasajero channel=passenger_driver_arrival_silent importance=4`,
  **vibró** (`setHwVibrator on`) y **despertó la pantalla**; en lockscreen: "APL Pasajero · 1 notificación".
- **Detalle:** canal `..._silent` → `hasValidSound=false` (vibra, sin sonido). Ver hallazgo §4.6.

---

## 4. Hallazgos (bugs / mejoras) — pedidos por Renzo

1. **Selector de hora del viaje programado difícil de editar.** El time picker (modo
   teclado) **concatena** dígitos en vez de reemplazar (5→"65", etc.); hay que borrar a
   mano. Además el botón OK se mueve al cerrar el teclado. → que los campos se
   seleccionen-todo al enfocar o usar un picker más simple.
2. **No notifica cuando no encuentra vehículo/conductor.** Ni por capacidad (AS2, queda
   girando en "Buscando") ni por distancia (>4 km, vuelve a inicio en silencio). Nunca
   muestra el motivo de `no_drivers_available`. **El botón "Reintentar" tampoco
   funciona.** → devolver y mostrar el motivo + reintentar/cambiar nº de pasajeros.
3. **Permiso de GPS se re-pregunta a cada rato.** El diálogo "Usar tu ubicación" reaparece
   siempre; y sin permiso la app usa ubicación de respaldo lejana **sin avisar** → consultar
   el estado del permiso antes de mostrarlo; no pedir viajes con ubicación falsa silenciosa.
4. **(Mejora) El pasajero debe poder abrir el viaje programado** y ver el preview del
   recorrido + toda la info (hoy solo hay tarjeta con fecha y "Cancelar").
5. **(Mejora) La alerta de nuevo viaje al conductor debe repetir hasta que la vea/abra**
   (reconocimiento explícito), no sonar una sola vez. *(La voz sí suena minimizada y con
   pantalla apagada — confirmado.)*
6. **Notificación de llegada al pasajero: ponerle SONIDO (tono), sin voz hablada.** Hoy el
   canal es silencioso (vibra pero no suena). La voz TTS es solo del conductor.
7. **Cancelación admin: el pasajero no se entera y queda un mensaje pegado.** No hay
   notificación de cancelación (debería ser **vibración + sonido, sin voz**), y la app
   muestra "el viaje finalizó, puedes calificarlo en Actividad" — **incorrecto** (fue
   *cancelado*, no finalizado) y **se queda pegado** un buen rato. → push de cancelación
   + mensaje "viaje cancelado" y limpiar el estado (volver a "Pedir un viaje").

> Estos hallazgos también están en la memoria de Claude
> (`~/.claude/projects/.../memory/`), archivos `bug_*` / `feature_*`. Para Codex, esta
> sección es la fuente de verdad.

---

## 5. Notas técnicas clave

- **`cancelledBy`** desde el dashboard queda como `"dashboard"` (no `"admin"`). El motivo
  de cancelación se guarda en **`/trips/<TRIP>/cancelReason`** (no en `cancellationReason`).
- **Cancelar viaje (dashboard)** usa un **`prompt()` nativo** del navegador para el motivo;
  ese diálogo congela la automatización (CDP/inyección) → hay que escribir el motivo a mano
  o manejar el diálogo por CDP.
- **Emparejamiento:** anillos `[2 km, 4 km]`. Conductor a >4 km del punto de recogida → no
  se asigna (confirmado con la ubicación de respaldo lejana del pasajero).
- **"Finalizar viaje" (conductor)** está geo-restringido a la cercanía del destino
  ("Acércate al destino (a Nm) para poder confirmar").
- **Samsung** a veces se cae de adb tras HOME/POWER (modo MTP) y re-enumera con otro
  `transport_id`; reconecta solo. Lanzar la app del conductor: `monkey -p apl.tucompras.com -c android.intent.category.LAUNCHER 1`.

**Estado del backend al pausar:** 37 Cloud Functions desplegadas; dashboard en vivo OK;
conductor `$D` `online`, `currentTripId=null` (libre). Sin viajes activos.
