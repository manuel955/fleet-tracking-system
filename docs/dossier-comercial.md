# Dossier comercial de la solución

## 1. Resumen ejecutivo

La solución es una plataforma de transporte corporativo para organizaciones que necesitan coordinar pasajeros, conductores y vehículos desde un solo sistema. Combina dos aplicaciones móviles y un centro de control web:

```text
Pasajero                  Plataforma                  Operación
---------                 ----------                  ---------
Pide un viaje  ────────▶  Asigna vehículo  ────────▶  Conductor ejecuta
Ve el vehículo  ◀──────  Actualiza estados  ◀──────  Envía GPS
```

El producto está diseñado para viajes corporativos sin cobro por viaje dentro de la aplicación. La operación puede administrar la disponibilidad, el seguimiento, la aprobación documental, los lugares frecuentes y el historial.

## 2. Qué recibe el cliente

La solución completa incluye:

1. **App de pasajeros**: registro, credencial, selección de destino, solicitud de viaje, viajes programados, seguimiento del conductor, llamada, soporte e historial.
2. **App de conductores**: registro con correo y contraseña, datos del vehículo, carga documental, aprobación administrativa, inicio y fin de turno, GPS en segundo plano, alertas y ejecución del viaje.
3. **Dashboard de operaciones**: mapa de flota, estados por color, búsqueda, filtros, ficha del conductor, asignación de lugar, cancelación administrativa, aprobación de documentos, asistencia, historial y configuración.
4. **Backend**: autenticación, base de datos en tiempo real, almacenamiento de documentos, asignación automática, ciclo de vida del viaje, notificaciones push y publicación de builds Android.
5. **Documentación y transferencia**: código fuente, configuración de servicios, procedimientos de despliegue, checklist de pruebas y capacitación acordada en el contrato.

## 3. Usuarios y responsabilidades

| Usuario | Usa | Puede hacer |
|---|---|---|
| Pasajero | App de pasajeros | Registrarse, indicar credencial, elegir origen/destino, solicitar o programar un viaje, cancelar mientras el flujo lo permite, llamar al conductor y consultar actividad. |
| Conductor | App de conductores | Registrarse, cargar documentos, corregir documentos rechazados, iniciar turno, enviar posición, recibir servicios, llegar, iniciar y finalizar viajes. |
| Supervisor | Dashboard | Ingresar al panel, monitorear la operación y realizar las acciones habilitadas para su rol. |
| Administrador | Dashboard | Además de operar, aprobar/rechazar conductores, administrar usuarios, lugares, marca, soporte y versiones de las apps. |

## 4. Funcionalidades por superficie

### App de pasajeros

- Activación mediante QR temporal del hotel, con vencimiento, límite de usos y revocación.
- Registro de nombre, teléfono y foto de credencial; vinculación opcional de correo para recuperar la cuenta sin SMS.
- Mapa con ubicación de recogida.
- Búsqueda de destino con Mapbox Geocoding API, lugares recientes o pin fijo en el mapa.
- Geocodificación inversa para convertir un punto seleccionado en una dirección.
- Selector de 1 a 45 pasajeros.
- Viaje inmediato o programado.
- Asignación automática del vehículo elegible más cercano.
- Visualización de nombre, teléfono, placa, tipo, color y capacidad del vehículo.
- Seguimiento del conductor antes de recoger al pasajero y ruta hacia el destino una vez iniciado el viaje.
- Notificaciones de llegada y cambios de destino.
- Historial de los últimos 7 días en la vista normal, con soporte técnico para consultar todo el historial.
- Calificación del viaje completado y reporte de incidencias posteriores, con seguimiento abierto/resuelto en el dashboard.

### App de conductores

- Registro con datos personales y del vehículo.
- Tipos de vehículo: Auto, SUV, Mini van, Van, Mini bus y Bus.
- Capacidad validada por tipo: de 1 a 45 pasajeros, según la categoría.
- Carga de foto o PDF para documentos.
- Aprobación o rechazo con motivo y campos que deben corregirse.
- Bloqueo operativo mientras la cuenta no está aprobada.
- Inicio de turno y envío de ubicación GPS con servicio en primer plano.
- Aviso de nuevo servicio por push y por consulta periódica de respaldo.
- Flujo guiado: “He llegado” → “Pasajero a bordo” → “Finalizar viaje”.
- Bloqueo de las confirmaciones de llegada/finalización cuando el GPS está a más de 100 metros del objetivo, siempre que exista una posición disponible.
- Llamada al pasajero, apertura de la ruta en Mapbox, soporte y actualización obligatoria de versión cuando el administrador publica un build mayor.

### Dashboard de operaciones

- Mapa en vivo con vehículos aprobados.
- Estados operativos: Disponible, En ruta de recogida, En viaje y Desconectado.
- Filtros por estado y búsqueda por nombre, placa o lugar asignado.
- Ficha del conductor con última actualización GPS y viaje activo.
- Ruta del conductor seleccionado hacia el punto de recogida o destino.
- Punto de recogida y destino diferenciados en el mapa.
- Aprobación documental y generación de un PDF de revisión del conductor.
- Rechazo con motivo y selección de documentos que debe corregir.
- Asignación de hoteles o sedes deportivas.
- Historial de viajes y asistencia basada en conexiones/desconexiones.
- Gestión de usuarios del dashboard con roles de supervisor y administrador.
- Configuración de soporte, logo, nombre del dashboard, marca de las apps y publicación de APK.

## 5. Cada cuánto se actualiza el mapa

Esta es la información que conviene incluir en una propuesta o demostración:

| Parte del sistema | Comportamiento implementado | Qué puede afectar la experiencia |
|---|---:|---|
| Envío de GPS desde el conductor | Primer envío al iniciar el rastreo y luego cada **5 segundos** | Permisos, GPS, ahorro de batería, cobertura y conexión de datos. |
| Asignación automática | Solo considera posiciones con una antigüedad menor a **3 minutos** | Si el teléfono no reporta, el conductor no se considera elegible. |
| Dashboard: recepción del vehículo | Listener de Firebase Realtime Database, actualizado cuando cambia el dato | La posición visible depende de que llegue el envío del teléfono. |
| Dashboard: revisión visual de antigüedad | Cada **5 segundos** | Sirve para cambiar el estado visual aunque no haya una nueva escritura. |
| Dashboard: posición atrasada | Después de **45 segundos** sin actualización, el marcador se muestra atenuado | No significa que el vehículo se haya movido; significa que la señal está vieja. |
| Dashboard: retiro del mapa | Después de **3 minutos** sin GPS | Evita mostrar como actual una posición vieja. |
| Pasajero buscando conductor | Consulta el estado del viaje cada **3 segundos** | El tiempo real de asignación depende también de Cloud Functions y la red. |
| Pasajero en viaje: estado | Consulta cada **4 segundos** | Se usa como mecanismo de lectura del viaje. |
| Pasajero en viaje: posición | Consulta cada **5 segundos** | La posición nueva solo existe cuando el conductor la envió. |
| Conductor: servicio asignado | Consulta `currentTripId` cada **5 segundos**, además del push FCM | El push acelera el aviso; el polling recupera el estado si el push falla. |
| Viaje programado | El backend revisa viajes programados cada **1 minuto** y despacha dentro de los **10 minutos previos** | El momento exacto puede variar por la ventana del scheduler. |

**Frase recomendada para el cliente:** “El conductor transmite su ubicación cada 5 segundos. El dashboard la recibe en tiempo real y muestra el vehículo con una antigüedad visible; después de 45 segundos lo marca como atrasado y después de 3 minutos lo retira del mapa hasta recibir una nueva señal. Estos valores son intervalos técnicos, no una promesa de latencia de red.”

## 6. Cómo funciona la asignación

1. El pasajero envía origen, destino y cantidad de pasajeros.
2. El viaje se crea como `searching`, salvo que sea programado.
3. Cloud Functions busca conductores aprobados, disponibles, con GPS reciente y capacidad suficiente.
4. Prioriza la categoría mínima que cubre la cantidad solicitada y, dentro de ella, la cercanía. Si no encuentra uno cercano, puede elegir una categoría superior antes de revisar uno más lejano de la categoría mínima.
5. Reclama al conductor con control de concurrencia para evitar asignarlo a dos viajes simultáneos.
6. El viaje pasa directamente a `accepted`; no existe una etapa de aceptar o rechazar por parte del conductor.
7. Si no hay un vehículo elegible, el viaje pasa a `no_drivers_available` y el pasajero puede reintentar.

## 7. Límites y dependencias que deben figurar en la oferta

- La ubicación depende del teléfono del conductor, su permiso de ubicación, la batería, el GPS y la conexión móvil.
- El sistema necesita Firebase Realtime Database, Authentication, Storage, Cloud Functions y Cloud Messaging.
- El mapa, la búsqueda de direcciones y las rutas dependen de Mapbox y de sus cuotas/costos.
- Las apps móviles auditadas son Android/Flutter; la entrega para iOS requiere validar firma, configuración y distribución específica.
- La publicación automática de APK depende de GitHub Actions y secretos de compilación configurados.
- La disponibilidad, los tiempos de soporte, el número máximo de vehículos, la retención de historial y los costos de terceros deben quedar en el contrato como condiciones separadas.

## 8. Entregables recomendados para cerrar la venta

- Código fuente y repositorio transferido.
- Proyecto Firebase transferido o con propietario administrativo del cliente.
- Proyecto Firebase/Google Cloud transferido con su cuenta de facturación y
  cuenta Mapbox transferida con límites de consumo definidos por el cliente.
- Cuenta/organización de GitHub Actions y secretos de build transferidos de forma segura.
- Keystore de producción y procedimiento de rotación custodiados por el cliente.
- URLs de producción, credenciales iniciales y matriz de roles entregadas fuera del repositorio.
- Prueba de aceptación firmada con los tiempos de actualización, flujo de viaje y casos de desconexión.
- Capacitación y horas de soporte posterior definidas en contrato.
