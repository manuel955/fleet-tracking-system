# Base de datos

## Implementación: Firebase Realtime Database

La aplicación usa **Firebase Realtime Database** para el estado operativo en
tiempo real:

- Sincronizacion en tiempo real nativa (`on('value', ...)`) sin tener que
  montar tu propio servidor de WebSockets.
- SDK web para el dashboard y endpoints REST autenticados desde Flutter y
  Cloud Functions.
- Recuperación local controlada en las apps móviles cuando no hay red.
- Reglas de seguridad declarativas por nodo (ver `firebase-rules.json`).
- Índices y límites declarados en `firebase-rules.json` para las consultas de
  viajes, accesos, invitaciones, alertas e incidencias.

## Configuracion

1. Crea o abre el proyecto en <https://console.firebase.google.com>.
2. Habilita **Realtime Database** en modo bloqueado.
3. Habilita **Authentication > Anonymous** para la sesión inicial del
   pasajero y **Email/Password** para conductor, dashboard y recuperación del
   pasajero. No habilites Phone/SMS: este proyecto no lo utiliza.
4. Despliega `firebase-rules.json` mediante Firebase CLI; no copies reglas
   parciales desde la consola.
5. Despliega también `storage.rules` y las Cloud Functions. Las escrituras
   sensibles de viajes, accesos, GPS e incidencias se realizan en servidor.

Los nodos principales actuales son `drivers`, `driverLocations`, `trips`,
`tripHistory`, `passengers`, `passengerInvites`, `passengerAccess`,
`tripFeedback`, `auditLogs`, `operationAlerts`, `scheduledTrips` y `config`.

## Alternativa: PostgreSQL

Si prefieres una base relacional autoalojada, usa `postgres-schema.sql`.
Ten en cuenta que Postgres no empuja datos a los clientes por si solo:
necesitaras Supabase Realtime o un servidor propio (Node/Express +
Socket.io) como capa intermedia entre la base de datos y el dashboard/app.
La implementacion de referencia de este proyecto (driver-app y dashboard)
esta construida sobre Firebase.
