# Sistema visual — APL Logistic

## Contexto del producto

- **Qué es:** sistema de transporte corporativo con app para pasajeros, app para conductores y dashboard operativo.
- **Usuarios:** pasajeros que necesitan pedir un vehículo, conductores que ejecutan servicios y operadores que controlan la flota.
- **Espacio:** movilidad corporativa, rastreo en tiempo real y operaciones.
- **Tipo:** aplicaciones móviles Flutter y dashboard web interno.
- **Promesa emocional:** APL Logistic debe sentirse seguro, premium, rápido y bajo control.

## Dirección estética

- **Dirección:** Industrial Premium.
- **Decoración:** intencional y contenida. La personalidad vive en la tipografía, el contraste y los estados operativos.
- **Mood:** tecnología confiable con el cuidado visual de una marca ejecutiva. No debe parecer un clon genérico de una app de taxis.
- **Decisión de tema:** solo apariencia clara en producción. No agregar selector de modo oscuro.

## Tipografía

- **Títulos y marca:** Instrument Sans, pesos 600–700, con tracking ligeramente negativo.
- **Texto de interfaz:** DM Sans, pesos 400–700, para lectura cómoda en móvil y escritorio.
- **Datos operativos:** IBM Plex Mono, pesos 500–600, para placas, builds, horas, cantidades y estados técnicos.
- **Carga:** Google Fonts en dashboard; fallback local sans-serif en las apps móviles si la fuente no está disponible.
- **Escala:** 12/14/16/18/22/28/36/52 px según jerarquía.

## Color

- **Base oscura:** `#081618` para navegación, encabezados y CTA principales.
- **Superficie profunda:** `#102426` y `#183438` para capas dentro del dashboard.
- **Fondo claro:** `#F5F7F3` y `#E9EEEA` para superficies y mapas.
- **Acento de marca:** `#C8F267` para disponibilidad, selección y acciones positivas.
- **Éxito/activo:** `#20B879`.
- **Advertencia/en ruta:** `#F5B94C`.
- **Error/cancelación:** `#E96B61`.
- **Información:** `#78A7FF`.
- **Regla:** el color comunica estado; no decorar tarjetas con colores sin significado.

## Espaciado y forma

- **Unidad:** 4 px.
- **Densidad:** cómoda, con prioridad a la lectura rápida en operación.
- **Escala:** 4, 8, 12, 16, 24, 32, 48, 64 px.
- **Radios:** 10 px para controles, 16 px para tarjetas, 24 px para superficies principales, 999 px solo para estados/pills.
- **Bordes:** 1 px con bajo contraste; las sombras deben separar capas, no decorar.

## Layout

- **Dashboard:** mapa protagonista con barra lateral operativa, métricas compactas y paneles que no oculten la ubicación de la flota.
- **Pasajero:** mapa como pantalla principal y tarjeta inferior con destino, capacidad, vehículo y conductor.
- **Conductor:** estado del turno como acción primaria, viaje actual como contenido dominante y documentación dividida en pasos.
- **Responsive:** una columna en teléfonos; dos zonas en tablet y escritorio; nunca reducir controles esenciales hasta hacerlos difíciles de tocar.

## Componentes y estados

- **CTA principal:** fondo `#081618`, texto claro; usar el verde lima cuando la acción represente disponibilidad o confirmación.
- **Estado disponible:** punto verde más etiqueta clara.
- **Estado en ruta:** ámbar.
- **Estado en viaje:** azul.
- **Estado desconectado:** gris, sin competir visualmente con la operación.
- **Alertas:** deben explicar qué ocurrió y qué puede hacer la persona después.
- **Vehículos:** la ilustración usa el tipo y color declarado por cada conductor.

## Movimiento

- **Enfoque:** funcional e intencional.
- **Duración:** micro 80–120 ms, corta 160–240 ms, media 280–380 ms.
- **Uso:** transiciones de tarjetas, cambios de estado, apertura de paneles y confirmaciones.
- **Evitar:** animaciones constantes que distraigan al operador o consuman batería durante el rastreo.

## Decisiones

| Fecha | Decisión | Motivo |
|---|---|---|
| 2026-08-03 | Adoptar Industrial Premium | Une seguridad, velocidad, control y una identidad propia para movilidad corporativa. |
| 2026-08-03 | Mantener solo tema claro | El usuario aprobó la dirección clara y pidió no agregar “Modo” oscuro. |
| 2026-08-03 | Usar verde lima como señal operativa | Hace que disponibilidad y confirmaciones sean reconocibles sin saturar toda la interfaz. |
