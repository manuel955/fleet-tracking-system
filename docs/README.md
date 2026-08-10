# Documentación de la solución de gestión de flota

Esta carpeta reúne la documentación preparada para presentar, operar, desplegar y entregar el sistema de transporte corporativo.

La documentación fue actualizada contra el código y la configuración revisados el 9 de agosto de 2026. Los tiempos marcados como confirmados describen el comportamiento implementado. La experiencia final todavía depende de la cobertura GPS, la conexión de datos, el teléfono, Firebase y Mapbox.

## Documentos

| Documento | Para quién | Contenido |
|---|---|---|
| [Dossier comercial](dossier-comercial.md) | Cliente, comprador o dirección | Qué es la solución, qué incluye, capacidades, tiempos de actualización y alcance de la venta. |
| [Manual de operación](manual-operacion.md) | Operadores, conductores y pasajeros | Cómo usar cada superficie y qué hacer ante los casos habituales. |
| [Referencia técnica](referencia-tecnica.md) | Equipo técnico o comprador de la plataforma | Arquitectura, datos, estados, endpoints, permisos e intervalos reales. |
| [Guía de despliegue y entrega](guia-despliegue-y-entrega.md) | Instalador, equipo TI y comprador | Requisitos, despliegue, publicación de apps, dashboard, pruebas y checklist de transferencia. |

## Versiones Word

Las mismas piezas están disponibles en formato `.docx` para enviarlas al cliente o incorporarlas al expediente de venta:

- [Índice de documentación](word/README.docx)
- [Dossier comercial](word/dossier-comercial.docx)
- [Manual de operación](word/manual-operacion.docx)
- [Referencia técnica](word/referencia-tecnica.docx)
- [Guía de despliegue y entrega](word/guia-despliegue-y-entrega.docx)

## Resumen de la solución

- App de pasajeros con acceso QR temporal, cuenta recuperable por correo, viajes inmediatos o programados, seguimiento, historial, calificación e incidencias.
- App de conductores para registrarse, cargar documentos, esperar aprobación, iniciar turno, enviar GPS en segundo plano y ejecutar el viaje por etapas.
- Dashboard web para monitorear la flota sobre Mapbox, revisar conductores, administrar lugares, consultar historial, asignar sedes, gestionar usuarios y publicar actualizaciones.
- Backend serverless sobre Firebase Realtime Database, Firebase Authentication, Firebase Storage, Cloud Functions y Firebase Cloud Messaging.

## Datos que no deben copiarse a un documento comercial

Las claves de Firebase/Mapbox, tokens, contraseñas, teléfonos internos, correos administrativos, llaves de firma, archivos `google-services.json` y URLs firmadas deben entregarse por un canal seguro y separado. Los documentos públicos usan marcadores como `<FIREBASE_PROJECT_ID>` o `[URL_DEL_DASHBOARD]`.

## Pendientes antes de una entrega productiva

1. Rotar y restringir las claves de cliente por dominio, aplicación, certificado y API.
2. Desplegar y validar este grupo de cambios de Realtime Database, Storage, Cloud Functions y dashboard.
3. Mantener el dashboard detrás de HTTPS y revisar periódicamente usuarios y custom claims.
4. ✅ Confirmar la keystore release definitiva, custodiarla fuera del repositorio y cargarla en GitHub Secrets. El inventario de huellas y la evidencia están en [`release-signing/`](release-signing/); los builds release sin `FLEET_KEYSTORE_*` fallan de forma segura.
5. Ejecutar la prueba de aceptación del [checklist de entrega](guia-despliegue-y-entrega.md#checklist-de-aceptación) con teléfonos físicos y una flota representativa.
