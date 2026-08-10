# Revisión de rechazo de Google Play: eliminación de cuenta

Fecha: 10 de agosto de 2026.

Google Play devolvió dos avisos equivalentes: el enlace de eliminación de
cuenta/datos no era válido porque no identificaba claramente la aplicación, el
desarrollador o la empresa de la ficha de Play.

## Corrección aplicada

Se creó una página específica para el producto, con el nombre visible, la
empresa y el identificador Android dentro del contenido:

`https://rastreoflota-53052.web.app/apl-pasajero/eliminacion-de-cuenta.html`

La página identifica:

- `APL Pasajero` / `APL Pasajeros`.
- `APL Logistics`.
- Paquete Android `apl.tucomprass.pasajero`.
- Eliminación desde la app y solicitud alternativa por correo.
- Datos que se eliminan y excepciones legales/de seguridad.

La URL anterior se conserva para compatibilidad, pero no debe volver a
introducirse en el formulario de Seguridad de los datos para la app de
pasajeros.

## Acción necesaria en Play Console

En la ficha de **APL Pasajero**, abre **Política de aplicaciones / Seguridad de
los datos / Eliminación de cuenta** y reemplaza el enlace por la URL nueva de
arriba. Guarda el formulario y envía nuevamente la declaración para revisión.

Después de publicar el web de pasajeros, verifica la URL en una ventana
privada, sin iniciar sesión, y comprueba que responde con HTTP 200. La página
no requiere autenticación.

Las capturas originales quedan archivadas junto a este documento:

- [`passenger-deletion-rejection-1.png`](passenger-deletion-rejection-1.png)
- [`passenger-deletion-rejection-2.png`](passenger-deletion-rejection-2.png)
