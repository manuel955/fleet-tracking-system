# Manual de operación

## 1. Operador del dashboard

### Ingresar

1. Abre `[URL_DEL_DASHBOARD]`.
2. Inicia sesión con un usuario de Firebase Authentication de tipo correo/contraseña.
3. Verifica que aparezca el indicador “En vivo” y que el mapa cargue.

### Leer el mapa

- **Verde**: disponible para recibir un viaje.
- **Naranja**: asignado y en ruta hacia el punto de recogida.
- **Azul**: pasajero a bordo y viaje en curso.
- **Gris**: desconectado, sin posición válida o sin señal reciente.
- Un marcador atenuado indica que la última posición tiene más de 45 segundos.
- Si no hay actualización durante 3 minutos, el marcador se retira del mapa.

Selecciona un vehículo para centrar el mapa, abrir su ficha y ver la ruta activa. El punto azul representa el lugar de recogida y el punto morado representa el destino.

### Revisar y aprobar conductores

1. Abre **Conductores**.
2. Filtra por **Pendiente**.
3. Revisa datos personales, placa, vehículo y documentos.
4. Usa **Ver archivo completo** para generar un PDF de revisión con los datos y los documentos disponibles.
5. Si todo está correcto, selecciona **Aprobar**.
6. Si falta o está vencido un documento, selecciona **Rechazar**, marca los documentos a corregir y escribe un motivo claro, por ejemplo: “SOAT vencido”.
7. El conductor recibe el cambio y, si fue rechazado, puede volver a cargar solamente los documentos marcados.

Un conductor pendiente o rechazado no puede iniciar turno, enviar GPS ni recibir viajes.

### Revisar alertas de desconexión

1. Pulsa **Alertas** en la barra superior para revisar las desconexiones en tiempo real.
2. Una desconexión manual, administrativa o pérdida de señal genera una alerta automáticamente.
3. Usa **Llamar**, **Notificar** o **Ver ubicación final** según el procedimiento operativo.
4. Pulsa **Reconocer** cuando la alerta haya sido atendida.

El sistema considera heartbeat válido el GPS enviado cada 5 segundos. Después de 30 segundos sin actualización, el backend marca la pérdida de señal y registra la alerta en **Conductores → Alertas de desconexión**.

### Asignar un hotel o sede

1. Abre **Lugares** y registra el nombre y la dirección del hotel o sede deportiva.
2. El sistema obtiene las coordenadas mediante Mapbox.
3. En la ficha del conductor, selecciona el lugar y pulsa **Asignar lugar**.
4. El conductor recibe una notificación y verá el lugar asociado en su perfil.

### Cancelar un viaje asignado

1. Selecciona el conductor con el viaje activo.
2. Revisa el destino y el estado antes de actuar.
3. Pulsa **Cancelar viaje** y confirma.
4. Escribe o conserva el motivo operativo registrado por el dashboard.

La cancelación libera al conductor mediante Cloud Functions cuando la transición llega al backend. Si la pantalla no cambia, actualiza el dashboard y revisa el historial.

### Consultar historial y asistencia

- **Historial de viajes** muestra viajes archivados cuando terminan o se cancelan.
- **Asistencia** usa eventos de conexión y desconexión registrados por el backend.
- Para una investigación, anota fecha, hora, conductor, placa, viaje y última actualización GPS.

## 2. Conductor

### Primer registro

1. Instala la app entregada por la operación.
2. Crea una cuenta con correo y contraseña.
3. Completa nombre, edad, teléfono, DNI, placa, marca, tipo, color y capacidad del vehículo.
4. Carga la foto de perfil y los documentos solicitados.
5. Envía el registro.

El DNI se carga como **dos fotos** o **un solo PDF**. Los documentos se almacenan en Firebase Storage y el perfil queda en `pending_review`.

### Después de la aprobación

1. Abre la app y concede permisos de ubicación “todo el tiempo” o equivalentes del sistema.
2. Activa el GPS del teléfono.
3. Pulsa **Iniciar turno**.
4. Mantén visible la notificación del servicio de rastreo en primer plano.
5. Comprueba en el mapa que aparece una posición real.

La app envía una posición inmediatamente y luego cada 5 segundos. Si el GPS o la red fallan, el panel de actividad muestra el punto del error.

El botón **Iniciar turno** actualiza la disponibilidad en el backend. Al terminar manualmente el turno, se registra la desconexión con motivo **Desconexión manual**.

### Ejecutar un viaje

1. Cuando el sistema asigna un servicio, la app avisa por push y lo recupera por consulta de respaldo.
2. Revisa pasajero, teléfono, cantidad, origen y destino.
3. Usa **Ruta** para abrir Mapbox si necesitas navegación externa.
4. Al llegar al origen, desliza **He llegado**. La app valida cercanía cuando tiene una posición GPS disponible.
5. Cuando el pasajero suba, desliza **Pasajero a bordo**.
6. Al llegar al destino, desliza **Finalizar viaje**.

El conductor no acepta, rechaza ni cancela el servicio desde la app. La asignación es automática y la cancelación administrativa la realiza el dashboard según el procedimiento de la operación.

### Si la app dice que el viaje no llega

Revisa en este orden:

1. Que la cuenta esté aprobada.
2. Que el turno esté iniciado.
3. Que el GPS esté encendido y el permiso siga vigente.
4. Que la última actualización tenga menos de 3 minutos.
5. Que el vehículo tenga capacidad para la cantidad de pasajeros.
6. Que exista conexión móvil.
7. Que el dashboard no haya cancelado el viaje.

## 3. Pasajero

### Registrar una cuenta

1. Instala la app.
2. Escanea o pega el código QR entregado por el hotel.
3. Ingresa nombre, teléfono y foto de DNI/carnet.
4. Confirma el registro y, si deseas recuperar la cuenta en otro equipo, vincula un correo y contraseña.

El registro se conserva localmente para no repetirlo en cada apertura. Al cerrar sesión, la implementación elimina el perfil, la foto y el historial asociado cuando la red lo permite.

### Pedir un viaje

1. En **Inicio**, confirma el punto de recogida.
2. Selecciona un destino con búsqueda, recientes, lugares configurados por la empresa o pin en el mapa.
3. Indica la cantidad de pasajeros.
4. Elige **Ahora** o **Programar**.
5. Confirma el viaje.

Mientras se busca un conductor, la app consulta el estado cada 3 segundos. Si no hay un vehículo elegible, muestra la razón y permite reintentar.

### Seguir el viaje

Cuando se asigna el conductor, la app muestra nombre, teléfono, placa, tipo, color y capacidad. La posición del vehículo se consulta cada 5 segundos y el estado del viaje cada 4 segundos.

Al finalizar o cancelar, abre **Actividad**, toca el viaje y registra una calificación, comentario o incidencia. Una incidencia requiere una descripción suficiente y aparecerá en **Conductores → Incidencias** para el administrador hasta que la marque como resuelta.

Este sistema gestiona transporte corporativo sin cobro por viaje, por lo que el flujo termina sin pantalla de pago ni captura de tarjeta.

- Antes de abordar, la ruta se calcula hacia el punto de recogida.
- Después de abordar, la ruta se calcula hacia el destino.
- Si Mapbox Directions API no responde, se muestra una línea directa como referencia visual.
- Puedes llamar al conductor desde la tarjeta del viaje.

### Modificar destino o cancelar

La app permite modificar el destino mientras el viaje sigue activo y notifica al conductor. El botón de cancelación se muestra en la etapa en la que el pasajero todavía puede cancelar según las reglas y el flujo de la operación. Una vez asignado el conductor, la cancelación operativa debe gestionarse desde el dashboard.

## 4. Procedimiento ante incidencias

| Síntoma | Revisión | Acción |
|---|---|---|
| Vehículo no aparece | Último GPS, aprobación y estado del turno | Pedir al conductor abrir la app, revisar permisos y reiniciar el turno. |
| Posición atrasada | Hora de `lastUpdate` | Verificar GPS, batería, cobertura y notificación del servicio en primer plano. |
| “Sin conductores disponibles” | Capacidad, aprobación, posición fresca y disponibilidad | Reintentar si hay un conductor operativo o revisar la cantidad solicitada. |
| Push no llega | Token FCM y permisos de notificación | El polling sigue siendo respaldo; abrir la app y comprobar permisos. |
| Ruta recta | Respuesta de Mapbox Directions API | Revisar cuotas, API habilitada y restricción de la clave. |
| No permite confirmar llegada | Distancia GPS al objetivo | Acercarse al punto; el umbral implementado es de 100 metros cuando hay posición. |
| App exige actualización | Build remoto mayor al local | Descargar la APK publicada desde el dashboard y reinstalar. |

## 5. Operación diaria recomendada

Antes de iniciar servicios, el operador debe confirmar que el dashboard abre, que Mapbox carga, que los conductores aprobados aparecen, que hay al menos un teléfono enviando GPS y que el soporte configurado es correcto. Al cerrar el día, revisar viajes cancelados, incidencias abiertas, viajes en curso, asistencia y conductores que quedaron sin señal.
