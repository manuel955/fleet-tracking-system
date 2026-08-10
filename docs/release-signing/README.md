# Registro de firma Android

Última verificación: 10 de agosto de 2026.

## Certificado de publicación

La clave release que debe usarse para los paquetes Android de APL es la
keystore privada `apl-logistics-upload.jks`, con alias `aplLogisticsUpload`.
La clave está custodiada fuera del repositorio y se cargó en GitHub Actions
mediante secretos; este documento no contiene contraseñas ni material
privado.

| Dato | Valor verificado |
| --- | --- |
| SHA1 de subida esperado por Google Play | `70:F3:02:09:6D:1F:87:43:A2:15:B2:EB:B8:F4:30:41:EE:55:D5:A7` |
| SHA256 de la clave release | `B4:06:7C:0F:52:52:47:C0:02:92:18:65:79:99:A9:44:DE:55:F8:F9:19:3B:94:71:F4:86:C7:44:02:27:4D:11` |
| SHA1 de la clave debug/legacy rechazada | `44:37:1C:05:33:E8:21:DB:5B:C9:FF:21:B6:40:66:3F:62:97:A8:E5` |
| SHA256 de la clave debug/legacy rechazada | `F4:E1:98:84:74:EE:DE:90:D6:AE:14:23:BE:31:C9:D4:A7:76:0F:80:D9:91:BE:94:55:1E:14:28:7C:52:C4:B5` |

La captura que originó este registro se conserva en
[`play-console-driver-key-error.png`](play-console-driver-key-error.png).
Muestra que Google Play espera la primera huella y que el AAB rechazado se
firmó con la huella debug/legacy.

## Distinción importante

La huella de subida no es necesariamente la huella de firma de aplicación que
se observa en un APK instalado desde Google Play. Para Conductores, el APK
instalado puede mostrar la firma administrada por Google Play; eso es normal.
Para subir un AAB nuevo se debe usar la clave de subida registrada arriba.

## Reglas establecidas

1. Los workflows de release solo aceptan `ANDROID_RELEASE_KEYSTORE_BASE64`,
   `ANDROID_RELEASE_KEYSTORE_PASSWORD`, `ANDROID_RELEASE_KEY_ALIAS`,
   `ANDROID_RELEASE_KEY_PASSWORD` y `ANDROID_RELEASE_CERT_SHA256`.
2. Los workflows verifican la huella SHA256 antes de compilar y, para
   Conductores, también la SHA1 esperada por Play Console.
3. No se permite usar `ANDROID_DEBUG_KEYSTORE_BASE64` como respaldo de una
   compilación release.
4. Si falta la keystore release o no coincide alguna huella, el job termina sin
   generar un paquete publicable.
5. Nunca se deben subir al repositorio la keystore, contraseñas, certificados
   privados ni archivos `google-services.json`.

## Estado

- La clave release correcta ya está configurada en GitHub Secrets.
- El AAB que mostraba la captura no es reutilizable: debe generarse uno nuevo
  después de esta configuración.
- No se desinstalaron aplicaciones del teléfono para evitar borrar sus datos.
