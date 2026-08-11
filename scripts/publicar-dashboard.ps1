param(
  [string]$Servidor = '86.48.19.189',
  [string]$Dominio = ''
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
$dashboard = Join-Path $raiz 'dashboard'
$clave = Join-Path $env:USERPROFILE '.ssh\pos_contabo_ed25519'
$archivo = Join-Path $env:TEMP "fleet-dashboard-$PID.tar.gz"
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$archivoRemoto = "/tmp/fleet-dashboard-$stamp.tar.gz"
$destinoRemoto = '/opt/fleet-dashboard'
$stagingRemoto = "/opt/fleet-dashboard.stage.$stamp"
$composeRemoto = '/opt/sistema-pos/docker-compose.prod.yml'
$envRemoto = '/opt/sistema-pos/.env.production'
$overrideRemoto = '/opt/sistema-pos/docker-compose.fleet-dashboard.yml'
$caddyRemoto = '/opt/sistema-pos/Caddyfile'

if ([string]::IsNullOrWhiteSpace($Dominio)) {
  throw 'Publicacion bloqueada: define un dominio con HTTPS usando -Dominio (por ejemplo apl.tucomprass.com).'
}

if ($Dominio -match '^[0-9.]+$') {
  throw 'Publicacion bloqueada: un certificado publico requiere un dominio DNS, no una direccion IP.'
}

if ($Dominio -match '[^a-zA-Z0-9.-]' -or $Dominio.StartsWith('.') -or $Dominio.EndsWith('.')) {
  throw 'Dominio invalido: usa solo letras, numeros, guiones y puntos.'
}

if (-not (Test-Path -LiteralPath $dashboard)) {
  throw "No se encontro la carpeta del dashboard: $dashboard"
}

if (-not (Test-Path -LiteralPath $clave)) {
  throw "No se encontro la llave SSH de despliegue: $clave"
}

if (-not $env:MAPBOX_ACCESS_TOKEN) {
  throw 'Define MAPBOX_ACCESS_TOKEN antes de publicar el dashboard; no se permite publicar un mapa sin token Mapbox.'
}

$overrideContenido = @"
services:
  caddy:
    volumes:
      - /opt/fleet-dashboard:/srv/fleet-dashboard:ro
"@

$caddyBloque = @"
#BEGIN_APL_FLEET_DASHBOARD
$Dominio {
  root * /srv/fleet-dashboard
  try_files {path} /index.html
  encode zstd gzip
  header {
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy no-referrer
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    Cross-Origin-Opener-Policy same-origin
    Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://www.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://api.mapbox.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.mapbox.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https://firebasestorage.googleapis.com https://api.mapbox.com https://*.tiles.mapbox.com; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.cloudfunctions.net https://api.mapbox.com https://events.mapbox.com https://*.tiles.mapbox.com; frame-src https://rastreoflota-53052.firebaseapp.com; worker-src 'self' blob: https://cdnjs.cloudflare.com"
  }
  file_server
}
#END_APL_FLEET_DASHBOARD
"@

$overrideBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($overrideContenido))
$caddyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($caddyBloque))

try {
  Push-Location $raiz
  try {
    & node .\scripts\inject-mapbox-config.mjs
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo generar la configuracion runtime de Mapbox.' }

    & tar.exe -czf $archivo -C $dashboard .
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo empaquetar el dashboard.' }
  }
  finally {
    Pop-Location
  }

  & scp.exe -i $clave -o BatchMode=yes -o ConnectTimeout=15 $archivo "root@${Servidor}:$archivoRemoto"
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo subir el dashboard al VPS.' }

  # Caddy ya existe dentro del stack sistema-pos. Se usa un override para
  # montar el dashboard sin tocar el compose principal del POS.
  $comandoRemoto = @(
    'set -e',
    'command -v docker >/dev/null',
    'command -v rsync >/dev/null',
    "test -f $composeRemoto",
    "test -f $envRemoto",
    "test -f $caddyRemoto",
    "cp $composeRemoto ${composeRemoto}.backup-before-fleet-$stamp",
    "cp $caddyRemoto ${caddyRemoto}.backup-before-fleet-$stamp",
    "rm -rf $stagingRemoto",
    "mkdir -p $stagingRemoto $destinoRemoto",
    "tar -xzf $archivoRemoto -C $stagingRemoto",
    "rsync -a --delete $stagingRemoto/ $destinoRemoto/",
    "rm -rf $stagingRemoto $archivoRemoto",
    "echo $overrideBase64 | base64 -d > $overrideRemoto",
    # El Caddyfile puede conservar CRLF al editarlo desde Windows; normalizar
    # antes de quitar el bloque evita que se acumulen hosts duplicados.
    "sed -i 's/\r$//' $caddyRemoto",
    "sed -i '/^#BEGIN_APL_FLEET_DASHBOARD$/,/^#END_APL_FLEET_DASHBOARD$/d' $caddyRemoto",
    "echo $caddyBase64 | base64 -d >> $caddyRemoto",
    "docker compose --env-file $envRemoto -f $composeRemoto -f $overrideRemoto -f /opt/sistema-pos/docker-compose.fleet-api.yml config >/dev/null",
    "docker compose --env-file $envRemoto -f $composeRemoto -f $overrideRemoto -f /opt/sistema-pos/docker-compose.fleet-api.yml up -d caddy",
    "docker compose --env-file $envRemoto -f $composeRemoto -f $overrideRemoto -f /opt/sistema-pos/docker-compose.fleet-api.yml exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile",
    "curl -fsS --resolve ${Dominio}:80:127.0.0.1 http://${Dominio}/ >/dev/null"
  ) -join '; '

  & ssh.exe -i $clave -o BatchMode=yes -o ConnectTimeout=15 "root@$Servidor" $comandoRemoto
  if ($LASTEXITCODE -ne 0) { throw 'El VPS no pudo publicar o validar el dashboard dentro de Caddy.' }

  Write-Host "Dashboard publicado en el VPS: https://${Dominio}/" -ForegroundColor Green
  Write-Host 'La validez publica del certificado HTTPS se confirma cuando el registro DNS A apunte al VPS.' -ForegroundColor Yellow
}
finally {
  if (Test-Path -LiteralPath $archivo) {
    Remove-Item -LiteralPath $archivo -Force
  }
}
