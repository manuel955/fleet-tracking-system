# Base de datos

## Recomendacion: Firebase Realtime Database

Para ~100 vehiculos enviando su posicion cada 30 segundos, **Firebase
Realtime Database** es la opcion mas simple y adecuada:

- Sincronizacion en tiempo real nativa (`on('value', ...)`) sin tener que
  montar tu propio servidor de WebSockets.
- SDKs oficiales para Flutter/React Native y Web.
- Soporte offline en el cliente movil (encola escrituras si no hay red).
- Reglas de seguridad declarativas por nodo (ver `firebase-rules.json`).
- Costo y complejidad operativa minimos para este volumen de datos
  (100 dispositivos escribiendo cada 30s ≈ 200 escrituras/min).

## Configuracion

1. Crea un proyecto en https://console.firebase.google.com
2. Habilita **Realtime Database** (modo bloqueado/locked).
3. Habilita **Authentication > Anonymous** (lo usa la app del conductor) y
   **Authentication > Email/Password** (lo usa el panel de administracion:
   crea ahi manualmente el usuario admin que usara el dashboard).
4. Copia el contenido de `firebase-rules.json` en Realtime Database > Rules.

## Alternativa: PostgreSQL

Si prefieres una base relacional autoalojada, usa `postgres-schema.sql`.
Ten en cuenta que Postgres no empuja datos a los clientes por si solo:
necesitaras Supabase Realtime o un servidor propio (Node/Express +
Socket.io) como capa intermedia entre la base de datos y el dashboard/app.
La implementacion de referencia de este proyecto (driver-app y dashboard)
esta construida sobre Firebase.
