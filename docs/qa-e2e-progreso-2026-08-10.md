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
| **Calificación automática al finalizar (pasajero)** | ❌ | Al terminar el viaje, el pasajero no es enviado automáticamente a la pantalla de calificación; debe entrar manualmente a Actividad. |
| **Aviso de GPS desactualizado (pasajero)** | ❌ | Durante el viaje aparece «Señal GPS del conductor temporalmente desactualizada»; este mensaje no debe mostrarse al pasajero como estado normal. |
| **Notif llegada** (`driver_arrived`) | ✅ | UI del pasajero sincroniza; confirmado también en segundo plano (ver §3) |
| **E** Calificación/incidencia (pasajero) | ✅ | "5/5 · Incidencia enviada" (Objeto perdido); `submitTripFeedback` OK |
| **K** Historial | ✅ | Actividad muestra el viaje completado con conductor/fecha |
| **G** Cancelación pasajero | ✅ | Canceló en "Buscando", volvió limpio a "Pedir un viaje" |
| **AS2** 5 pax → sin capacidad | ⚠️ | Exclusión por asientos OK (Auto de 4 **no** se asigna, `currentTripId=null`), pero la app queda en "Buscando" **sin mensaje** → hallazgo (§4) |
| **C** Dashboard monitoreo | ✅ | Dashboard muestra al conductor en vivo (Ever, CYV627, "En ruta de recogida"), auto en el mapa y panel VIAJE ACTUAL (pasajero, estado, recogida, destino, GPS fresco). El "0 vehículos" inicial es solo demora de carga. |
| **F** Cancelación admin | ✅ | Desde dashboard "Cancelar viaje" + prompt de motivo → `status=cancelled`, `cancelledBy="dashboard"`, `cancelReason` registrado, conductor liberado |
| **Notif segundo plano — conductor** | ✅ | Voz de asignación **con pantalla apagada/dozing** (ver §3) |
| **Notif segundo plano — pasajero** | ✅ | `driver_arrived` **con pantalla apagada/asleep** (ver §3) |
| **Notif con app CERRADA (killed)** | ❌ | Con la app del conductor forzada a detener (`stopped=true`, sin proceso), el viaje sí pasó a `accepted` y quedó asignado, pero no hubo FCM/TTS ni notificación visible. Al reabrir la app, el viaje apareció asignado y se completó correctamente. |
| **I** Coordinador (crear/detalle/cancelar) | ✅ | `createCoordinatorTrip` (Solicitud creada, asignó a Ever/CYV627 con voz) → `getCoordinatorTripDetail` (modal seguimiento EN VIVO, ID `-OzijToEeWAhah4Uc5_L`) → `cancelCoordinatorTrip` (`cancelled`, `cancelledBy="coordinator"`, conductor liberado). Coordinador "irma", sede Westin Lima. |
| **E — lado admin** (`manageTripFeedback`) | ✅ | Admin → Conductores → **Incidencias**: la incidencia "Objeto perdido" (gabi plaza/Ever) → **Marcar resuelta** (Resuelta, "0 abiertas") → **Reabrir** (Abierta, "1 abierta"). Ciclo OK. |
| **H** Auto-despacho de viaje programado | ✅ | Viaje programado para las 22:39; `dispatchScheduledTrips` lo pasó de `scheduled` a `accepted` a las 22:29:04 (10 min antes), asignó a Ever/CYV627, y se completó el flujo `arrived_at_pickup` → `in_progress` → `completed`. Para validar la geocerca se movió el destino al punto actual del conductor; conductor liberado y pasajero lo ve en Actividad. |

---

## 2. Pendientes (para continuar)

| Caso | Qué falta | Requisito |
|---|---|---|
| **AS3** Multi-driver (asientos/cercanía) | Auto vs SUV dentro/fuera de anillos; ver reglas en el plan §3. | 1–2 teléfonos más con conductores de distinta capacidad |
| **J** Registro conductor | Registro con documentos → `pending_review` → aprobar/rechazar+motivo/reenviar. Gestión en admin → **Conductores** (pestañas Aprobado/Pendiente/Rechazado/Suspendido). | Otro equipo |

> **Coordinador:** la ruta de despacho es la misma `apl.tucomprass.com` logueado con un
> usuario **coordinador** (p. ej. "irma", sede Westin Lima); el admin y el coordinador
> son logins distintos sobre el mismo hosting (la UI cambia según el rol).
> **Incidencias/feedback (E-admin):** admin → **Conductores** → pestaña **Incidencias**.

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

**Conductor — aplicación forzada a detener (killed):**
- Se limpió Logcat y se ejecutó `am force-stop apl.tucompras.com`; el paquete quedó
  `stopped=true` y `pidof apl.tucompras.com` vacío.
- El backend asignó el viaje (`accepted`, `driverId=$D`), pero no apareció ningún registro
  nuevo de FCM/`NotificationManager`, no sonó TTS y no hubo notificación visible.
- Al abrir de nuevo la app, recuperó el viaje asignado y el flujo se completó; el conductor
  volvió a `online`.

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
8. **(Mejora) Toda notificación debe avisar y guiar a dónde está**, como la de "nueva
   solicitud de conductor" (alerta + deep-link a la vista relevante). Estandarizar ese
   patrón para todas las notificaciones (dashboard y apps).
9. **(Mejora) Clic en una incidencia debe abrir su detalle** con info completa de
   **pasajero + conductor + viaje** (hoy es solo una fila con acción resolver/reabrir).
10. **Voz de viaje programado:** al asignarse un viaje del mismo día, el conductor
    escucha la fecha numérica (por ejemplo, "diez octavos"). Debe decir **"Hoy a las
    [hora]"**; para otra fecha, usar una frase natural con día y mes.
11. **FALLO TOTAL — FCM con app del conductor forzada a detener:** Android no entrega el aviso/voz cuando
    el paquete está `stopped=true`; el viaje se asigna en backend, pero el conductor no se
    entera hasta abrir la app. Revisar el canal de notificación y la estrategia de entrega
    para este estado del sistema.
12. **Calificación automática al finalizar para el pasajero:** al completar el viaje, abrir
    inmediatamente la vista de calificación (con opción de omitir o hacerlo después en
    Actividad), en vez de dejar al pasajero en la pantalla anterior.
13. **Mensaje «Señal GPS del conductor temporalmente desactualizada»:** no debe aparecer al
    pasajero como aviso durante un viaje; corregir la condición de refresco o reemplazarlo
    por un estado silencioso que no alarme al usuario mientras el viaje sigue activo.

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
